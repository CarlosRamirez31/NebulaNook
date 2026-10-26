// Live diff and the finished line, end to end through the hook handler: file
// edits become ticker steps with their diff stored (and bounded), and Stop leaves
// Claude's final message on the card until the next turn.

import { afterEach, beforeEach, mock, test } from "node:test";
import assert from "node:assert/strict";
import { emit } from "./tauri.mjs";
import { registerHookHandlers } from "../src/island/hooks.ts";
import { DEFAULT_SETTINGS, State } from "../src/core/state.ts";
import { parseDiffStep } from "../src/core/diff.ts";
import { KNOWN_AGENTS } from "../src/island/agents.ts";
import { buildActivityPeek } from "../src/views/activity-peek.ts";
import { ActivityCard } from "../src/views/activity.ts";
import { installFakeDom } from "./fakedom.mjs";

const CLAUDE = "integration_claude";

let shown = [];
const island = {
  alert(view) { shown.push(["alert", view]); },
  setView(view) { shown.push(["view", view]); },
  showFileDiff(id) { shown.push(["diff", id]); },
  reveal() {}, dropPin() {},
};
registerHookHandlers(island);

const hook = (payload) => emit("hook", payload);
const task = (id = CLAUDE) => State.tasks.find((t) => t.id === id);
const diffs = (id = CLAUDE) => State.sessionDiffs.get(id) ?? [];

const edit = (extra = {}) =>
  hook({
    hook_event_name: "PostToolUse",
    cwd: "/p/proj",
    tool_name: "Edit",
    tool_input: { file_path: "/p/proj/src/app.ts", old_string: "a\nb\n", new_string: "a\nc\nd\n" },
    ...extra,
  });

beforeEach(() => {
  shown = [];
  mock.timers.enable({ apis: ["setTimeout"] });
  for (const id of [...State.sessionDiffs.keys()]) State.clearSessionDiffs(id);
  State.tasks = [];
  State.focusId = null;
  State.mode = "hidden";
  State.view = "overview";
  State.paused = false;
  State.isPinned = false;
  State.pendingApproval = null;
  State.settings = { ...DEFAULT_SETTINGS };
  State.loadIntegrationTasks();
});

test("every integrated agent records ordinary file edits without opening the panel", () => {
  for (const agent of [undefined, ...Object.keys(KNOWN_AGENTS)]) {
    const pill = agent ? `agent_${agent}` : CLAUDE;
    const session = `files-${agent ?? "claude"}`;
    const payload = { coucou_agent: agent, session_id: session, tool_name: "edit_file", tool_use_id: "edit-1" };
    shown = [];
    hook({ ...payload, hook_event_name: "PreToolUse", tool_input: { path: "README.md", old_str: "old", new_str: "new" } });
    assert.equal(State.focusId, pill);
    assert.deepEqual(shown, [["diff", null]], "edits must not open a window");
    assert.equal(diffs(pill).length, 0, "an intended edit is not an applied diff");
    hook({ ...payload, hook_event_name: "PostToolUse" });
    const [diff] = diffs(pill);
    assert.equal(diff.path, "README.md");
    assert.deepEqual(shown.at(-1), ["diff", diff.id]);
    assert.equal(State.mode, "hidden", "recording a diff must not expand the island");
    assert.ok(shown.every(([kind]) => kind === "diff"));
  }
});

test("Codex native command-shaped patches render actual changed code instead of the history list", () => {
  const dom = installFakeDom();
  document.createDocumentFragment = dom.root;
  const card = new ActivityCard({ dismiss() {}, open() {} });
  const patch = "*** Begin Patch\n*** Update File: notes.md\n@@\n-before\n+after\n*** End Patch";
  const payload = { coucou_agent: "codex", session_id: "native-patch", tool_use_id: "patch-1", tool_name: "apply_patch", tool_input: { command: patch } };
  hook({ ...payload, hook_event_name: "PreToolUse" });
  const agent = task("agent_codex");
  card.sync(agent);
  assert.ok(card.el.querySelector(".tracking-editor"));
  assert.equal(card.el.querySelector(".activity-list"), null);
  assert.match(card.el.querySelector(".tracking-file-tab").textContent, /notes.md/);
  assert.match(card.el.querySelector(".removed").textContent, /before/);
  assert.match(card.el.querySelector(".added").textContent, /after/);
  assert.equal(Object.values(agent.historyDetails)[0].command, undefined);
  assert.doesNotMatch(agent.steps.at(-1), /Begin Patch/);
  assert.equal((card.el.textContent.match(/Codex/g) ?? []).length, 1);
  hook({ ...payload, hook_event_name: "PostToolUse" });
  card.sync(agent);
  assert.equal(diffs("agent_codex").length, 1);
  assert.match(card.el.querySelector(".tracking-code").textContent, /before/);
  assert.match(card.el.querySelector(".tracking-code").textContent, /after/);
});

test("native shell reads show each file's numbered code and never the action history", () => {
  const dom = installFakeDom();
  document.createDocumentFragment = dom.root;
  const card = new ActivityCard({ dismiss() {}, open() {} });
  const payload = { coucou_agent: "codex", session_id: "native-read", tool_name: "Bash",
    tool_input: { command: "cat one.cs; sed -n '1,20p' two.cs" },
    coucou_activity: { files: [{path:"/p/one.cs",content:"class One {}\n"}, {path:"/p/two.cs",content:"class Two {}\n"}] } };
  hook({ ...payload, hook_event_name: "PreToolUse" });
  hook({ ...payload, hook_event_name: "PostToolUse" });
  card.sync(task("agent_codex"));
  assert.equal(card.el.querySelector(".activity-list"), null);
  assert.equal(card.el.querySelector(".tracking-terminal"), null);
  assert.equal(card.el.find(".tracking-file-tab").length, 2);
  assert.match(card.el.querySelector(".tracking-code").textContent, /class Two/);
  card.el.find(".tracking-file-tab")[0].fire("click");
  assert.match(card.el.querySelector(".tracking-code").textContent, /class One/);
  assert.equal(card.el.querySelector(".code-line-number").textContent, "1");
});

for (const agentId of [undefined, ...Object.keys(KNOWN_AGENTS)]) {
test(`${agentId ?? "claude"}: Read, Edit, Bash and Done reach both tracking views`, () => {
  const dom = installFakeDom();
  document.createDocumentFragment = dom.root;
  const peek = buildActivityPeek(() => {});
  const card = new ActivityCard({ dismiss() {}, open() {} });
  const base = { session_id: `tracking-${agentId ?? "claude"}`, coucou_agent: agentId };
  const pill = agentId ? `agent_${agentId}` : CLAUDE;
  const file = { path: "/p/notes.md", content: "# Before\n" };
  hook({ ...base, hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: file.path } });
  const agent = task(pill);
  assert.equal(Object.values(agent.historyDetails).at(-1).completed, false);
  peek.sync(agent);
  card.sync(agent);
  assert.equal(peek.el.querySelector(".peek-action").textContent, "Read");
  assert.ok(card.el.find(".tracking-stage")[0].classList.contains("active"));
  hook({ ...base, hook_event_name: "PostToolUse", tool_name: "Read", coucou_activity: { files: [file] } });
  assert.equal(Object.values(agent.historyDetails).at(-1).file.content, "# Before\n");
  peek.sync(agent);
  card.sync(agent);
  assert.match(peek.el.textContent, /# Before/);
  assert.match(card.el.textContent, /# Before/);
  hook({ ...base, hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: { file_path: file.path, old_string: "# Before", new_string: "# After" } });
  peek.sync(agent);
  card.sync(agent);
  assert.equal(peek.el.querySelector(".peek-action").textContent, "Edit");
  assert.ok(card.el.find(".tracking-stage")[1].classList.contains("active"));
  hook({ ...base, hook_event_name: "PostToolUse", tool_name: "Edit", coucou_activity: { files: [{ ...file, content: "# After\n" }] } });
  const edit = Object.values(agent.historyDetails).at(-1);
  assert.equal(edit.phase, "edit");
  assert.equal(edit.completed, true);
  assert.equal(edit.file.content, "# After\n");
  peek.sync(agent);
  card.sync(agent);
  assert.match(card.el.querySelector(".tracking-code").textContent, /# Before/);
  assert.match(card.el.querySelector(".tracking-code").textContent, /# After/);
  hook({ ...base, hook_event_name: "PreToolUse", tool_name: "functions.exec_command", tool_input: { cmd: "npm test" } });
  hook({ ...base, hook_event_name: "PostToolUse", tool_name: "functions.exec_command", coucou_activity: { terminal: { command: "npm test", output: "PASS tests/notes.test.ts", failed: false } } });
  const terminal = Object.values(agent.historyDetails).at(-1);
  assert.equal(terminal.phase, "bash");
  assert.equal(terminal.command, "npm test");
  assert.equal(terminal.output, "PASS tests/notes.test.ts");
  hook({ ...base, hook_event_name: "Stop", last_assistant_message: "Done." });
  assert.equal(agent.turnFinished, true);
  peek.sync(agent);
  card.sync(agent);
  assert.match(peek.el.querySelector(".peek-code").textContent, /npm test/);
  assert.match(peek.el.querySelector(".peek-code").textContent, /PASS tests\/notes.test.ts/);
  card.el.find(".tracking-stage")[3].fire("click");
  assert.match(card.el.querySelector(".tracking-terminal").textContent, /PASS tests\/notes.test.ts/);
  assert.equal(card.el.querySelector(".code-line"), null);
  card.el.find(".tracking-stage")[1].fire("click");
  assert.equal(card.el.querySelector(".tracking-terminal"), null);
  assert.ok(card.el.querySelector(".tracking-file-tab"));
  assert.ok(shown.every(([kind]) => kind === "diff"));
});
}

test("concurrent edits are correlated by call and session; ambiguous results get no guessed diff", () => {
  const pre = (session_id, tool_use_id, path) => hook({ hook_event_name: "PreToolUse", session_id, tool_use_id,
    tool_name: "Edit", tool_input: { file_path: path, old_string: "a", new_string: "b" } });
  const post = (session_id, tool_use_id, extra = {}) => hook({ hook_event_name: "PostToolUse", session_id, tool_use_id, tool_name: "Edit", ...extra });
  pre("parallel", "one", "first.txt");
  pre("parallel", "two", "second.json");
  pre("other-session", "one", "other.md");
  post("parallel");
  assert.equal(diffs().length, 0);
  post("parallel", "two");
  post("other-session", "one");
  post("parallel", "one", { hook_event_name: "PostToolUseFailure" });
  assert.deepEqual(diffs().map((d) => d.path), ["second.json", "other.md"]);
});

test("editing never takes a pending approval's focus or opens a truncated diff", () => {
  State.beginApproval({ pillId: CLAUDE, requestId: "approval", sessionId: "waiting", tool: "Bash", command: "ls" });
  State.view = "approval";
  hook({ hook_event_name: "PreToolUse", coucou_agent: "hermes", session_id: "busy", tool_name: "patch",
    tool_input: { path: "notes.txt", old_string: "a", new_string: "b" }, coucou_diff_truncated: true });
  hook({ hook_event_name: "PostToolUse", coucou_agent: "hermes", session_id: "busy", tool_name: "patch" });
  assert.equal(State.focusId, CLAUDE);
  assert.equal(State.pendingApproval.requestId, "approval");
  assert.deepEqual(shown, []);
  assert.deepEqual(diffs("agent_hermes"), []);
  State.endApproval();
});

afterEach(() => {
  mock.timers.runAll();
  mock.timers.reset();
});

// ── Live diff ─────────────────────────────────────────────────────────────────

test("a finished Edit adds a diff step with its counts, and keeps the diff", () => {
  edit();
  const step = parseDiffStep(task().steps.at(-1));
  assert.deepEqual({ ...step, diffId: undefined }, { filename: "app.ts", added: 2, removed: 1, diffId: undefined });
  const diff = State.findDiff(CLAUDE, step.diffId);
  assert.equal(diff.path, "/p/proj/src/app.ts");
  assert.ok(diff.hunks.length > 0);
});

test("Write and MultiEdit are diffed too; other tools and PreToolUse are not", () => {
  hook({ hook_event_name: "PostToolUse", tool_name: "Write", tool_input: { file_path: "C:\\p\\new.md", content: "x\ny\n" } });
  assert.deepEqual(parseDiffStep(task().steps.at(-1)).filename, "new.md");
  hook({
    hook_event_name: "PostToolUse",
    tool_name: "MultiEdit",
    tool_input: { file_path: "/p/m.ts", edits: [{ old_string: "a", new_string: "b" }, { old_string: "c", new_string: "d" }] },
  });
  const multi = parseDiffStep(task().steps.at(-1));
  assert.deepEqual([multi.added, multi.removed], [2, 2]);

  const before = task().steps.length;
  hook({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "ls" } });
  hook({ hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: { file_path: "/p/a.ts", old_string: "a", new_string: "b" } });
  assert.equal(task().steps.length, before + 2); // command result and the PreToolUse label
  assert.equal(parseDiffStep(task().steps.at(-1)), null);
  assert.equal(diffs().length, 2);
});

test("an edit with no change, or one the relay had to cut, adds no diff", () => {
  hook({ hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: { file_path: "/p/a.ts", old_string: "same", new_string: "same" } });
  edit({ coucou_diff_truncated: true });
  assert.deepEqual(task().steps, []);
  assert.equal(diffs().length, 0);
});

test("all file edits stay reachable beyond the old ticker and diff limits", () => {
  for (let i = 0; i < 60; i++) edit();
  const kept = diffs();
  assert.equal(kept.length, 60);
  assert.equal(task().history.length, 60);
  assert.equal(new Set(kept.map((d) => d.id)).size, 60);
  // The ticker keeps fewer steps than diffs; every step still finds its diff.
  for (const s of task().steps) assert.ok(State.findDiff(CLAUDE, parseDiffStep(s).diffId));
  // The first ones are gone: tapping their step would be a no-op.
  assert.equal(State.findDiff(CLAUDE, kept[0].id - 1), null);
});

test("history survives completion, session end and elapsed time until explicitly dismissed", () => {
  edit();
  mock.timers.tick(3_600_000);
  edit();
  mock.timers.tick(2000);
  assert.equal(diffs().length, 2);
  hook({ hook_event_name: "Stop" });
  hook({ hook_event_name: "SessionEnd", cwd: "/p/proj" });
  mock.timers.tick(3_600_000);
  assert.equal(diffs().length, 2);
  assert.equal(task().history.length, 2);
  State.dismissHistory(CLAUDE);
  assert.equal(diffs().length, 0);
  assert.deepEqual(task().history, []);
});

test("an ended agent's history stays until X dismisses its pill", () => {
  hook({ hook_event_name: "PreToolUse", coucou_agent: "gemini", tool_name: "Edit", tool_input: { file_path: "/p/a.ts" } });
  edit({ coucou_agent: "gemini" });
  assert.equal(diffs("agent_gemini").length, 1);
  hook({ hook_event_name: "SessionEnd", coucou_agent: "gemini" });
  assert.equal(task("agent_gemini").sessionEnded, true);
  assert.equal(State.sessionDiffs.has("agent_gemini"), true);
  State.dismissHistory("agent_gemini");
  assert.equal(task("agent_gemini"), undefined);
  assert.equal(State.sessionDiffs.has("agent_gemini"), false);
  // An event for a pill that does not exist stores nothing.
  edit({ coucou_agent: "ghost" });
  assert.equal(State.sessionDiffs.has("agent_ghost"), false);
});

// ── Final message ─────────────────────────────────────────────────────────────

test("Stop shows the first paragraph of Claude's final message, on one line", () => {
  hook({
    hook_event_name: "Stop",
    last_assistant_message: "**Done.** Fixed the `parser` and\nadded tests.\n\n## Details\n- a\n- b",
  });
  const line = "Done. Fixed the parser and added tests.";
  assert.equal(task().finalLine, line);
  assert.equal(task().steps.at(-1), line);
});

test("Stop falls back to `message`, and adds nothing when both are empty", () => {
  hook({ hook_event_name: "Stop", message: "All good." });
  assert.equal(task().finalLine, "All good.");
  hook({ hook_event_name: "UserPromptSubmit", prompt: "again" });
  hook({ hook_event_name: "Stop", last_assistant_message: "\n\n---\n" });
  assert.equal(task().finalLine, null);
  assert.equal(task().steps.at(-1), "again");
});

test("a long final message is kept to 200 characters", () => {
  hook({ hook_event_name: "Stop", last_assistant_message: "word ".repeat(100) });
  assert.ok(task().finalLine.length <= 200);
});

for (const [what, event] of [
  ["a new prompt", { hook_event_name: "UserPromptSubmit", prompt: "next" }],
  ["a tool starting", { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" } }],
  ["a new session", { hook_event_name: "SessionStart" }],
]) {
  test(`the final message stays until ${what}`, () => {
    hook({ hook_event_name: "Stop", last_assistant_message: "Done." });
    mock.timers.tick(5200); // back to idle: the line is still there
    assert.equal(task().state, "idle");
    assert.equal(task().finalLine, "Done.");
    hook({ cwd: "/p/proj", ...event });
    assert.equal(task().finalLine, null);
  });
}
