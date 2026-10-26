// Hook events from Claude Code and every other agent → island state.
// Port of HookServer.processEvent / processPermissionRequest from the macOS app.
// Difference from macOS: no terminal filter. On Windows the hook fires from any
// terminal (Windows Terminal, VS Code, PowerShell…) and all of them are handled.
// The relay has already mapped every agent's events and fields onto Claude
// Code's (hook/src/normalize.rs), so one handler serves them all.

import { Bridge, onEvent } from "../core/bridge";
import { fileName, makeDiffStep, parseDiffStep, toOneLine } from "../core/diff";
import { activityPhase, fileDiffs, fileInput, filePath, isFileEdit, pendingPreview, shellFilePreview, toolName, toolOperations } from "../core/file-activity";
import { Sound } from "../core/sound";
import { State, type AgentTask, type AskedQuestion, type FilePreview } from "../core/state";
import { pillDefinition } from "../core/pills";
import { APPROVAL_AGENTS, agentColor, agentName, validateAgent } from "./agents";
import type { Island } from "./island";
import { parseClaudePlan, restorePlanUsage } from "../core/plan";
import { setClaudePlanUsage, storedClaudePlanUsage } from "../views/usage";
import { N_, t } from "../i18n/i18n";

const CLAUDE_ID = "integration_claude";
const CURSOR_ID = "agent_cursor";

/** Clears the approval card if no decision was made before the hook gave up. */
let pendingTimeout: number | null = null;

/** Takes the approval or question card down and gives the island back. */
export function dropPendingCard(island: Island): void {
  if (!State.pendingApproval) return;
  State.endApproval();
  island.dropPin();
  if (State.view === "approval" || State.view === "question") {
    island.setView(State.defaultView());
  }
  State.notify();
}

/** The return to idle that Stop arms, per pill, so the next turn can cancel it. */
const stopTimers = new Map<string, number>();

function cancelStopTimer(id: string): boolean {
  const timer = stopTimers.get(id);
  if (timer == null) return false;
  window.clearTimeout(timer);
  stopTimers.delete(id);
  return true;
}

/** Events after which a pending permission request of the same session is moot. */
const TURN_OVER = new Set(["Stop", "StopFailure", "UserPromptSubmit", "SessionEnd", "Interrupt"]);

interface HookPayload {
  hook_event_name?: string;
  request_id?: string;
  session_id?: string;
  cwd?: string;
  message?: string;
  /** UserPromptSubmit carries `prompt`; `message` belongs to Notification/Stop. */
  prompt?: string;
  /** Stop: the turn's final answer (Markdown) — Claude Code's, Hermes's, Codex's. */
  last_assistant_message?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown> | string;
  tool_use_id?: string;
  tool_call_id?: string;
  call_id?: string;
  activity_index?: number;
  coucou_envelope?: boolean;
  coucou_activity?: { files?: FilePreview[]; terminal?: { command?: string; output?: string; failed?: boolean; processId?: string } };
  /** Set by the relay when an edit was too big to forward whole (> 256 KB). */
  coucou_diff_truncated?: boolean;
  /** Optional agent tag: lowercase, digits and hyphens, ≤ 24 chars. */
  coucou_agent?: string;
  /** Hermes: where the session runs (telegram, discord…; "cli" in a terminal). */
  platform?: string;
  /** "cursor" when Claude Code runs in Cursor's terminal (set by the relay). */
  term_editor?: string;
  /** StatusLine (the plan usage relay): Claude Code's 5-hour and weekly limits. */
  rate_limits?: unknown;
}

const PROJECT_ALIASES: Record<string, string> = {
  "notch-buddy": "Notch Buddy",
  notchbuddy: "Notch Buddy",
  notch_buddy: "Notch Buddy",
};

function aliasProjectName(name: string): string {
  return PROJECT_ALIASES[name.toLowerCase()] ?? name;
}

function lastPathComponent(p: string): string {
  const cleaned = p.replace(/[\\/]+$/, "");
  const idx = Math.max(cleaned.lastIndexOf("\\"), cleaned.lastIndexOf("/"));
  return idx >= 0 ? cleaned.slice(idx + 1) : cleaned;
}

/**
 * localizedStep() — same labels as the macOS app, in English and shown in the
 * interface language (src/i18n) when the step is recorded.
 */
const TOOL_LABELS: Record<string, string> = {
  Bash: N_("Runs"),
  Read: N_("Reads"),
  Write: N_("Writes"),
  Edit: N_("Edits"),
  Glob: N_("Searches"),
  Grep: N_("Searches"),
  WebSearch: N_("Searches the web"),
  WebFetch: N_("Fetches"),
  TodoWrite: N_("Tasks"),
  Task: N_("Agent"),
  LS: N_("Lists"),
  MultiEdit: N_("Edits"),
  NotebookEdit: N_("Notebook"),
  PowerShell: N_("Runs"),
  // Antigravity's tools (#298).
  run_command: N_("Runs"),
  view_file: N_("Reads"),
  write_to_file: N_("Writes"),
  replace_file_content: N_("Edits"),
  read_url_content: N_("Fetches"),
  search_web: N_("Searches the web"),
  ask_question: N_("Needs input"),
};

function stepLabel(tool: string, input: Record<string, unknown>): string {
  const labelTool = tool === "ask_question" || tool.endsWith(":ask_question") ? "ask_question" : tool;
  const base = toolName(tool);
  const label = TOOL_LABELS[labelTool] ? t(TOOL_LABELS[labelTool]) : isFileEdit(tool, input) ? t("Edits")
    : activityPhase(tool, input) === "read" ? t("Reads")
    : ["exec_command", "terminal", "shell", "bash", "run_command"].includes(base) ? t("Runs") : tool;
  const str = (k: string) => (typeof input[k] === "string" ? (input[k] as string) : null);
  if (["apply_patch", "patch"].includes(base)) {
    const patch = input.patch ?? input.input ?? input.patchText ?? input.command;
    if (typeof patch === "string") {
      const path = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/m.exec(patch)?.[1];
      if (path) return `${label} · ${lastPathComponent(path)}`;
    }
  }
  const cmd = str("command") ?? str("cmd");
  if (cmd) return `${label} · ${cmd.slice(0, 40)}`;
  const path = str("path");
  if (path) return `${label} · ${lastPathComponent(path)}`;
  const file = str("file_path");
  if (file) return `${label} · ${lastPathComponent(file)}`;
  const query = str("query");
  if (query) return `${label} · ${query.slice(0, 40)}`;
  const target = filePath(input);
  if (target) return `${label} · ${lastPathComponent(target)}`;
  const patch = input.patch ?? input.input;
  if (typeof patch === "string") {
    const path = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/m.exec(patch)?.[1];
    if (path) return `${label} · ${lastPathComponent(path)}`;
  }
  if (
    (tool === "ask_question" || tool.endsWith(":ask_question")) &&
    Array.isArray(input.questions) &&
    input.questions.length > 0
  ) {
    const firstQ = input.questions[0];
    if (typeof firstQ === "object" && firstQ !== null && typeof (firstQ as Record<string, unknown>).question === "string") {
      const q = ((firstQ as Record<string, unknown>).question as string).trim();
      if (q) return `${label} · ${q.slice(0, 40)}`;
    }
  }
  return label;
}

/**
 * What the Allow button actually authorises. Approving "Write" tells you nothing
 * — approving `Write · C:\…\.env` tells you everything, and the difference is
 * the whole point of approving from the island rather than blind.
 *
 * Ordered by how specific the field is, so an unfamiliar tool still shows
 * whatever identifying string it carries instead of falling back to its name.
 */
const APPROVAL_FIELDS = [
  "command", // Bash, PowerShell
  "file_path", // Write, Edit, MultiEdit, NotebookEdit
  "path", // Read, LS
  "url", // WebFetch
  "query", // WebSearch
  "pattern", // Glob, Grep
  "prompt", // Task
] as const;

function approvalTarget(tool: string, input: Record<string, unknown>): string {
  for (const field of APPROVAL_FIELDS) {
    const value = input[field];
    if (typeof value === "string" && value.trim()) {
      return `${tool} · ${value.trim()}`;
    }
  }
  return tool;
}

/**
 * The questions of an AskUserQuestion call, if the island can show all of them
 * as options to pick from. Anything it cannot is left to the terminal.
 */
function askedQuestions(tool: string, input: Record<string, unknown>): AskedQuestion[] | null {
  if (tool !== "AskUserQuestion" || !Array.isArray(input.questions)) return null;
  const out: AskedQuestion[] = [];
  for (const raw of input.questions as Record<string, unknown>[]) {
    const question = typeof raw?.question === "string" ? raw.question : "";
    const options = (Array.isArray(raw?.options) ? (raw.options as Record<string, unknown>[]) : [])
      .filter((o) => typeof o?.label === "string" && o.label)
      .map((o) => ({
        label: o.label as string,
        description: typeof o.description === "string" ? o.description : "",
      }));
    // A question cut short by the relay would be answered under the wrong text.
    if (!question || question.endsWith("…") || options.length < 2) return null;
    out.push({ question, options, multiSelect: raw.multiSelect === true });
  }
  return out.length > 0 ? out : null;
}

/** The Claude Code session's pill, named after its project for the session. */
function upsert(id: string, projectName: string, cwd: string, sessionId: string) {
  const t = State.upsertWorkspacePill(id, projectName, cwd);
  if (t && sessionId) t.sessionId = sessionId;
}

/** The session is over: the pill goes back as it was, or away if it was only there for it. */
function clearSession(id: string) {
  const t = State.tasks.find((x) => x.id === id);
  if (!t) return;
  if (!State.isKept(id)) {
    State.removeTask(id);
    return;
  }
  t.state = "idle";
  t.steps = [];
  t.stepIndex = 0;
  delete t.stepSeq;
  t.name = pillDefinition(id)?.name ?? t.name;
  t.pillBadge = null;
  t.sessionId = null;
  t.finalLine = null;
}

/** The final message stays on the card until the next turn starts. */
function clearFinalLine(id: string) {
  const t = State.tasks.find((x) => x.id === id);
  if (t) t.finalLine = null;
}

/**
 * Completed file-tool events → diffs stored for the pill and
 * ticker step with its +N −M counts. Nothing is kept for a pill that does not
 * exist, so a stray event cannot grow memory. An edit the relay had to cut
 * would give wrong counts: the PreToolUse step ("Edits · file") stands alone.
 */
function recordDiff(agentId: string, payload: HookPayload): number | null {
  if (payload.coucou_diff_truncated) return null;
  if (!State.tasks.some((t) => t.id === agentId)) return null;
  let latest: number | null = null;
  for (const diff of fileDiffs(payload.tool_name ?? "", fileInput(payload.tool_input))) {
    if (payload.cwd && !/^(?:[\\/]|[A-Za-z]:[\\/])/.test(diff.path)) {
      diff.path = `${payload.cwd.replace(/[\\/]+$/, "")}/${diff.path}`;
    }
    latest = State.appendSessionDiff(agentId, diff);
    State.appendStep(agentId, makeDiffStep(fileName(diff.path), diff.added, diff.removed, latest));
  }
  return latest;
}

// Some observers omit arguments after a tool finishes. Reuse its own pre-event,
// never another session's or an ambiguous concurrent call's input.
const editingCalls: { agent: string; session: string; tool: string; id?: string; payload: HookPayload; at: number; owner?: AgentTask }[] = [];
function trackFileCall(agent: string, session: string, event: string, payload: HookPayload): HookPayload {
  const now = Date.now();
  for (let i = editingCalls.length - 1; i >= 0; i--) {
    const call = editingCalls[i];
    if (call.owner !== State.tasks.find((task) => task.id === call.agent) || now - call.at > 300_000 || (TURN_OVER.has(event) && call.agent === agent && call.session === session)) editingCalls.splice(i, 1);
  }
  const tool = toolName(payload.tool_name ?? "");
  const id = payload.tool_use_id ?? payload.tool_call_id ?? payload.call_id;
  if (event === "PreToolUse" && (tool === "exec" || activityPhase(tool, fileInput(payload.tool_input)) !== "other")) {
    if (editingCalls.length >= 64) editingCalls.shift();
    editingCalls.push({ agent, session, tool, id, payload, at: now, owner: State.tasks.find((task) => task.id === agent) });
  }
  if (event !== "PostToolUse" && event !== "PostToolUseFailure") return payload;
  const matches = editingCalls.filter((call) => call.agent === agent && call.session === session && call.tool === tool && (id == null || call.id === id));
  if (matches.length !== 1) return payload;
  const call = matches[0];
  editingCalls.splice(editingCalls.indexOf(call), 1);
  return { ...payload, activity_index: call.payload.activity_index,
    tool_input: Object.keys(fileInput(payload.tool_input)).length ? payload.tool_input : call.payload.tool_input,
    coucou_diff_truncated: payload.coucou_diff_truncated || call.payload.coucou_diff_truncated };
}

export function registerHookHandlers(island: Island) {
  // The last plan numbers seen survive a restart, as on the Mac.
  State.planUsage ??= restorePlanUsage(storedClaudePlanUsage());
  void onEvent<HookPayload>("hook", (payload) => handleHook(island, payload));
}

function handleHook(island: Island, payload: HookPayload) {
  // Account-wide numbers from the status line relay, not part of any session:
  // keep the latest, nothing else (no reveal, no sound), paused or not.
  if (payload.hook_event_name === "StatusLine") {
    const usage = parseClaudePlan(payload.rate_limits);
    if (usage) setClaudePlanUsage(usage);
    return;
  }

  if (State.paused) {
    // Silence here used to cost Claude Code nearly two minutes: the relay waited
    // for a decision from an island that had already decided not to look. Say so,
    // and the terminal takes the question immediately.
    if (payload.request_id) void Bridge.approvalDecline(payload.request_id);
    return;
  }

  const name = payload.hook_event_name ?? "";
  const cwd = payload.cwd ?? "";
  const raw = lastPathComponent(cwd);
  const projectName = aliasProjectName(raw || "Session");

  // Route to the right pill. Valid coucou_agent → dynamic "agent_<name>" pill.
  // "claude" is reserved; absent or invalid → Claude Code's own pill: Cursor's
  // when it runs in Cursor's terminal (Mac #120), VS Code's otherwise.
  const validAgent = validateAgent(payload.coucou_agent);
  const workspaceId = payload.term_editor === "cursor" ? CURSOR_ID : CLAUDE_ID;
  const agentId = validAgent ? `agent_${validAgent}` : workspaceId;
  const isExternalAgent = validAgent !== null;
  const sessionId = payload.session_id ?? "";
  if (name !== "PreToolUse") payload = trackFileCall(agentId, sessionId, name, payload);

  if (["PreToolUse", "PostToolUse", "PostToolUseFailure"].includes(name) && !payload.coucou_diff_truncated) {
    const operations = toolOperations(payload.tool_name ?? "", payload.tool_input);
    if (operations.length) {
      const singleTerminal = operations.length === 1 && ["bash", "read"].includes(activityPhase(operations[0].tool, operations[0].input));
      operations.forEach((operation, index) => {
        const parent = payload.tool_use_id ?? payload.tool_call_id ?? payload.call_id;
        handleHook(island, { ...payload, tool_name: operation.tool, tool_input: operation.input,
          // The outer output belongs to the envelope, not an individual call.
          coucou_activity: singleTerminal ? payload.coucou_activity : undefined, coucou_envelope: true,
          tool_use_id: parent ? `${parent}:${index}` : undefined });
      });
      if (!singleTerminal && payload.coucou_activity?.terminal?.output) {
        // Keep the envelope's actual transcript together. It does not prove
        // that every nested operation succeeded individually.
        handleHook(island, { ...payload, tool_name: "Bash", coucou_envelope: true,
          tool_input: { command: operations.filter((op) => typeof op.input.cmd === "string").map((op) => op.input.cmd).join("\n") || "exec" },
          tool_use_id: undefined, tool_call_id: undefined, call_id: undefined });
      }
      if (name === "PreToolUse") trackFileCall(agentId, sessionId, name, payload);
      return;
    }
  }

  const followEditing = (diffId: number | null) => {
    if (State.pendingApproval) return;
    if (State.mode !== "expanded") State.setFocus(agentId);
    // Queue the preview; only the pointer opens the panel. Work continues while
    // the island is compact or hidden, just as for any other activity event.
    if (State.focusId === agentId) island.showFileDiff?.(diffId);
  };

  /** Alerts force the island open; work events only reveal the compact island. */
  const surface = (view: Parameters<Island["alert"]>[0], isAlert: boolean) => {
    if (State.mode === "expanded") {
      if (isAlert) island.setView(view);
    } else if (isAlert) {
      island.alert(view);
    } else if (State.mode === "hidden") {
      island.reveal();
    }
  };

  /** Ensure the agent pill exists (no-op for Claude Code). */
  const ensurePill = () => {
    if (isExternalAgent) {
      State.upsertExternalAgent(agentId, agentName(validAgent!), agentColor(validAgent!));
      const t = State.tasks.find((x) => x.id === agentId);
      if (t && cwd) t.sessionCwd = cwd;
      if (t && sessionId) t.sessionId = sessionId;
    } else {
      upsert(agentId, projectName, cwd, sessionId);
    }
    const task = State.tasks.find((t) => t.id === agentId);
    if (task) task.sessionEnded = false;
  };

  /**
   * Called where a handler is about to replace `finished` with a newer state:
   * the timer Stop armed would otherwise put the pill back to idle over it. The
   * badge that timer was going to clear goes now.
   */
  const supersedeStop = () => {
    if (cancelStopTimer(agentId)) State.setPillBadge(agentId, null);
  };

  // The turn that asked for a permission is over — answered in the terminal,
  // interrupted, or a new prompt — so the card would be lying. It goes, and the
  // relay is released without a decision. Same rule as the Mac.
  const pending = State.pendingApproval;
  if (
    pending &&
    TURN_OVER.has(name) &&
    pending.pillId === agentId &&
    pending.sessionId === (payload.session_id ?? "")
  ) {
    if (pendingTimeout != null) window.clearTimeout(pendingTimeout);
    pendingTimeout = null;
    if (pending.requestId) void Bridge.approvalDecline(pending.requestId);
    dropPendingCard(island);
  }

  // Read after the card above is dropped: its pill may have handed the front
  // back to the pill you were on.
  switch (name) {
    case "SessionStart":
      ensurePill();
      clearFinalLine(agentId);
      // Hermes through its gateway says where the session comes from.
      if (validAgent === "hermes" && payload.platform && payload.platform !== "cli") {
        State.appendStep(agentId, payload.platform.charAt(0).toUpperCase() + payload.platform.slice(1));
      }
      surface("overview", false);
      Sound.play("work");
      break;

    case "UserPromptSubmit": {
      ensurePill();
      supersedeStop();
      clearFinalLine(agentId);
      State.updateTask(agentId, "thinking");
      // The field is `prompt`; reading `message` meant this step was always blank.
      const asked = payload.prompt ?? payload.message;
      if (asked) State.appendStep(agentId, asked.slice(0, 60));
      surface("overview", false);
      break;
    }

    case "PreToolUse": {
      ensurePill();
      trackFileCall(agentId, sessionId, name, payload);
      supersedeStop();
      clearFinalLine(agentId);
      const tool = payload.tool_name ?? "Tool";
      if (toolName(tool) === "write_stdin") {
        const processId = String(fileInput(payload.tool_input).session_id ?? "");
        const task = State.tasks.find((task) => task.id === agentId);
        const previous = Object.entries(task?.historyDetails ?? {}).find(([, detail]) => detail.processId === processId);
        if (previous) {
          payload.activity_index = Number(previous[0]);
          State.updateTask(agentId, "working");
          break;
        }
      }
      const isQuestion = tool === "ask_question" || tool.endsWith(":ask_question");
      if (isQuestion) {
        State.updateTask(agentId, "question");
        State.appendStep(agentId, stepLabel(tool, fileInput(payload.tool_input)));
        Sound.play("question");
        surface("overview", true);
      } else {
        State.updateTask(agentId, "working");
        State.appendStep(agentId, stepLabel(tool, fileInput(payload.tool_input)));
        if (isFileEdit(tool, fileInput(payload.tool_input))) {
          followEditing(null);
        }
        surface("overview", false);
      }
      const input = fileInput(payload.tool_input);
      const phase = activityPhase(tool, input);
      State.setActivityDetail(agentId, { tool, phase, completed: false,
        file: payload.coucou_activity?.files?.[0] ?? pendingPreview(tool, input) ?? shellFilePreview(input.command ?? input.cmd, "", cwd),
        requestedDiff: !payload.coucou_diff_truncated ? fileDiffs(tool, input)[0] : undefined,
        command: ["bash", "read"].includes(phase) && typeof (input.command ?? input.cmd) === "string" ? String(input.command ?? input.cmd) : undefined });
      if (!payload.coucou_diff_truncated) {
        for (const diff of fileDiffs(tool, input).slice(1)) {
          State.appendStep(agentId, stepLabel(tool, { file_path: diff.path }));
          State.setActivityDetail(agentId, { tool, phase: "edit", completed: false, requestedDiff: diff });
        }
      }
      payload.activity_index = (State.tasks.find((task) => task.id === agentId)?.history?.length ?? 0) - 1;
      break;
    }

    case "PostToolUse":
      supersedeStop();
      // The question was answered in the terminal: the card would be lying.
      if (
        payload.tool_name === "AskUserQuestion" &&
        State.pendingApproval?.questions &&
        State.pendingApproval.sessionId === (payload.session_id ?? "")
      ) {
        if (pendingTimeout != null) window.clearTimeout(pendingTimeout);
        pendingTimeout = null;
        dropPendingCard(island);
      }
      State.updateTask(agentId, "working");
      {
        const task = State.tasks.find((t) => t.id === agentId);
        const first = task?.history?.length ?? 0;
        const diffId = payload.coucou_envelope ? null : recordDiff(agentId, payload);
        const tool = payload.tool_name ?? "";
        const input = fileInput(payload.tool_input);
        const phase = activityPhase(tool, input);
        if (payload.activity_index != null && task?.historyDetails?.[payload.activity_index]) {
          State.setActivityDetail(agentId, { ...task.historyDetails[payload.activity_index], completed: true }, payload.activity_index);
        }
        const files = (Array.isArray(payload.coucou_activity?.files) ? payload.coucou_activity.files : [])
          .filter((file) => typeof file?.path === "string" && typeof file?.content === "string" && file.content.length <= 128 * 1024);
        const shellFile = phase === "read" ? shellFilePreview(input.command ?? input.cmd, payload.coucou_activity?.terminal?.output, cwd) : undefined;
        if (shellFile && !files.length) files.push(shellFile);
        const assigned = new Set<FilePreview>();
        for (let index = first; index < (task?.history?.length ?? 0); index++) {
          const entry = parseDiffStep(task!.history![index]);
          const diff = entry ? State.findDiff(agentId, entry.diffId) : null;
          const file = files.find((file) => file.path === diff?.path) ?? (files.length === 1 ? files[0] : undefined);
          if (file) assigned.add(file);
          State.setActivityDetail(agentId, { tool, phase, completed: true, file }, index);
        }
        for (const file of files.filter((file) => !assigned.has(file))) {
          State.appendStep(agentId, stepLabel(tool, { file_path: file.path }));
          State.setActivityDetail(agentId, { tool, phase, completed: true, file });
        }
        const terminal = payload.coucou_activity?.terminal;
        if (phase === "bash" || (phase === "read" && typeof (input.command ?? input.cmd) === "string")) {
          const command = terminal?.command || String(input.command ?? input.cmd ?? "");
          const process = terminal?.processId ?? (toolName(tool) === "write_stdin" ? String(input.session_id ?? "") : undefined);
          const previous = process ? Object.entries(task?.historyDetails ?? {}).find(([, detail]) => detail.processId === process) : undefined;
          let index = previous ? Number(previous[0]) : payload.activity_index ?? (task?.history?.length ?? 0) - 1;
          if (!previous && payload.activity_index == null) {
            while (index >= 0 && !(task?.historyDetails?.[index]?.phase === phase && task.historyDetails[index].command === command)) index--;
          }
          if (index < 0 && (command || terminal?.output)) {
            State.appendStep(agentId, stepLabel(tool, { command }));
            index = (task?.history?.length ?? 0) - 1;
          }
          if (index >= 0) {
            const old = task?.historyDetails?.[index];
            const output = typeof terminal?.output === "string" ? terminal.output : "";
            State.setActivityDetail(agentId, { ...old, tool, phase, completed: true,
              command: previous ? old?.command : command, processId: process,
              output: `${old?.output ?? ""}${old?.output && output ? "\n" : ""}${output}`.slice(-16_000),
              failed: terminal?.failed === true }, index);
          }
        }
        if (diffId != null) followEditing(diffId);
        else if (files.length || phase === "bash") followEditing(null);
      }
      break;

    case "PostToolUseFailure":
      supersedeStop();
      State.updateTask(agentId, "working");
      State.appendStep(agentId, t("⚠ failed"));
      State.setActivityDetail(agentId, { tool: payload.tool_name ?? "", phase: activityPhase(payload.tool_name ?? "", fileInput(payload.tool_input)),
        completed: true, failed: true, command: payload.coucou_activity?.terminal?.command,
        output: payload.coucou_activity?.terminal?.output?.slice(-16_000) });
      break;

    case "Notification": {
      const message = payload.message ?? "";
      const lower = message.toLowerCase();
      if (lower.includes("rate limit") || lower.includes("limite d")) {
        supersedeStop();
        State.updateTask(agentId, "ratelimit");
        Sound.play("rate");
      } else if (message.endsWith("?")) {
        supersedeStop();
        State.updateTask(agentId, "question");
        State.appendStep(agentId, message);
      }
      break;
    }

    case "Stop": {
      State.updateTask(agentId, "finished");
      // Claude Code puts the turn's answer in the Stop payload itself, so there is
      // no transcript to read (the relay does not even forward its path). Other
      // agents report their last words the same way (Hermes, Codex) or as
      // `message`.
      const finalText = toOneLine(payload.last_assistant_message ?? payload.message ?? "");
      if (finalText) {
        State.appendStep(agentId, finalText);
        const t = State.tasks.find((x) => x.id === agentId);
        if (t) t.finalLine = finalText;
      }
      Sound.play("finish");
      // A card waiting for an answer is never covered by another alert.
      State.setPillBadge(agentId, "finished");
      cancelStopTimer(agentId);
      stopTimers.set(
        agentId,
        window.setTimeout(() => {
          stopTimers.delete(agentId);
          if (isExternalAgent && !State.tasks.find((t) => t.id === agentId)?.history?.length) {
            State.removeTask(agentId);
          } else {
            State.updateTask(agentId, "idle");
            State.setPillBadge(agentId, null);
          }
        }, 5200),
      );
      break;
    }

    case "Interrupt":
      // Codex: the user stopped the turn. Back to idle, nothing to celebrate.
      supersedeStop();
      State.updateTask(agentId, "idle");
      State.setPillBadge(agentId, null);
      break;

    case "StopFailure":
      supersedeStop();
      State.updateTask(agentId, "error");
      Sound.play("error");
      State.setPillBadge(agentId, "error");
      break;

    case "SessionEnd":
      // Nothing left for the timer to do, and it must not outlive the session: a
      // pill recreated within 5.2 s would be removed by it.
      cancelStopTimer(agentId);
      {
        const task = State.tasks.find((t) => t.id === agentId);
        if (task?.history?.length) {
          task.sessionEnded = true;
          State.updateTask(agentId, "idle");
          break;
        }
      }
      State.clearSessionDiffs(agentId);
      if (isExternalAgent) {
        State.removeTask(agentId);
      } else {
        State.updateTask(agentId, "idle");
        clearSession(agentId);
      }
      break;

    case "SubagentStart":
      State.appendStep(agentId, t("+ subagent"));
      break;

    case "SubagentStop":
      State.appendStep(agentId, t("• subagent done"));
      break;

    case "PermissionRequest": {
      // Only Claude Code and agents with a blocking decision adapter get a
      // card. Other events are declined so the agent retains its native prompt.
      if (isExternalAgent && !APPROVAL_AGENTS.has(validAgent!)) {
        if (payload.request_id) void Bridge.approvalDecline(payload.request_id);
        break;
      }

      const requestId = payload.request_id ?? "";
      // One card, one request. A second one must never quietly replace the first
      // — that would leave a human staring at request B while request A waits for
      // a decision nobody can give. Hand it straight back to the terminal.
      if (State.pendingApproval && State.pendingApproval.requestId !== requestId) {
        if (requestId) void Bridge.approvalDecline(requestId);
        break;
      }
      ensurePill();
      supersedeStop();
      if (pendingTimeout != null) window.clearTimeout(pendingTimeout);
      const tool = payload.tool_name ?? "Tool";
      const input = fileInput(payload.tool_input);
      // Claude Code asking a question is not a permission to grant: the island
      // shows the options and sends back the one that was picked. Only Claude
      // Code asks questions this way.
      const questions = isExternalAgent ? null : askedQuestions(tool, input);
      const view = questions ? "question" : "approval";
      // The card always comes up, even over another pill or an island that is
      // already open: its pill comes to the front, and the one you were on
      // comes back once you answer (Mac #117, #120).
      State.beginApproval({
        requestId,
        sessionId,
        pillId: agentId,
        tool,
        command: approvalTarget(tool, input),
        ...(questions ? { questions } : {}),
      });
      // The relay's short ack window closes in 800 ms; everything below this
      // line is synchronous, so the card really is up by the time it lands.
      if (requestId) void Bridge.approvalAck(requestId);
      State.updateTask(agentId, view);
      Sound.play(view);
      // Every supported agent's card comes up the same way: beginApproval
      // brought its pill to the front.
      island.alert(view);
      // Coucou answers within 108 s or not at all; after that the terminal has
      // taken over and the card would be lying.
      pendingTimeout = window.setTimeout(() => {
        pendingTimeout = null;
        dropPendingCard(island);
      }, 110_000);
      break;
    }

    default:
      break;
  }
  State.notify();
}
