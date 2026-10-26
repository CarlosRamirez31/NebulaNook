import { State, type AgentTask } from "../core/state";
import { codeTokens, historyPreview, previewLines, terminalHistory } from "../core/code-preview";
import { agentName } from "../island/agents";
import { clear, h, svg } from "./dom";
import { language, tl } from "../i18n/i18n";
import { isTestRun, terminalOutput, terminalSummary } from "./terminal";

/** The small card in the reference: current tool, file and three source lines. */
export function buildActivityPeek(open: () => void) {
  const project = h("b", { class: "peek-project" });
  const agent = h("span", { class: "peek-agent" });
  const count = h("span", { class: "peek-count" });
  const action = h("b", { class: "peek-action" });
  const target = h("span", { class: "peek-file" });
  const code = h("div", { class: "peek-code" });
  const el = h("button", { class: "activity-peek", title: tl("Open"), onclick: open },
    h("div", { class: "peek-who" }, h("span", { class: "peek-dot" }), project, agent, count),
    h("div", { class: "peek-tool" }, svg("M5 3h10l4 4v17H5z M14 3v5h5 M8 12h8 M8 16h8", 12, { stroke: 1.5 }), action, target), code);
  let rendered = "";
  return {
    el,
    sync(task: AgentTask) {
      const history = task.history ?? [];
      const detail = Object.values(task.historyDetails ?? {}).at(-1);
      const done = task.turnFinished || task.sessionEnded || task.state === "finished";
      const phase = done ? "done" : detail?.phase === "bash" && isTestRun(detail.command, detail.output) ? "test" : detail?.phase ?? "other";
      const commands = terminalHistory(task);
      const testRun = done ? commands.filter((entry) => isTestRun(entry.command, entry.output)).at(-1) : undefined;
      const terminal = testRun ?? commands.at(-1);
      const key = `${language()}~${task.id}~${history.length}~${phase}~${detail?.completed}~${terminal?.output ?? ""}~${terminal?.failed}`;
      if (key === rendered) return;
      rendered = key;
      project.textContent = task.name;
      agent.textContent = task.id.startsWith("agent_") ? agentName(task.id.slice(6)) : "Claude Code";
      const step = ["read", "edit", "bash", "test", "done"].indexOf(phase);
      count.textContent = step >= 0 ? `${step + 1}/5` : `${history.length}/${history.length}`;
      action.textContent = phase === "read" ? "Read" : phase === "edit" ? String(tl("Edit")) : phase === "bash" ? "Bash" : phase === "test" ? String(tl("Tests")) : phase === "done" ? String(tl("Done")) : detail?.tool ?? "";
      el.classList.toggle("is-done", !!done);
      el.classList.toggle("is-failed", !!terminal?.failed || task.state === "error");
      const selectedPhase = phase === "read" || phase === "edit" ? phase : undefined;
      const { file, diff, requested } = historyPreview(task, State.sessionDiffs.get(task.id) ?? [], undefined, selectedPhase);
      action.title = requested ? String(tl("Requested changes")) : "";
      const path = file?.path ?? diff?.path ?? "";
      const relative = task.sessionCwd && path.startsWith(`${task.sessionCwd}/`) ? path.slice(task.sessionCwd.length + 1) : path;
      const showTerminal = !!terminal && (phase === "bash" || phase === "test" || done);
      target.textContent = showTerminal ? terminal.command ?? "" : relative;
      target.title = showTerminal ? terminal.command ?? "" : path;
      clear(code);
      if (showTerminal) {
        code.classList.add("peek-terminal");
        code.append(h("div", { class: "terminal-command", text: `$ ${terminal.command ?? ""}` }));
        // Keep the reported totals at the end of long test runs visible.
        code.append(terminalOutput(terminalSummary(terminal.output ?? ""), terminal.failed));
        return;
      }
      code.classList.remove("peek-terminal");
      const preview = previewLines(file, diff, requested);
      const rows = phase === "edit" ? preview.filter((line) => line.kind !== "context") : preview;
      const changed = rows.findIndex((line) => line.kind !== "context");
      const start = changed >= 0 ? Math.max(0, changed - 1) : Math.max(0, rows.findIndex((line) => line.text.trim()));
      let visible = rows.slice(start, start + 3);
      const before = rows.find((line) => line.kind === "removed");
      const after = rows.find((line) => line.kind === "added");
      if (before && after && (!visible.some((line) => line.kind === "removed") || !visible.some((line) => line.kind === "added"))) {
        const context = rows[start]?.kind === "context" ? rows[start] : undefined;
        visible = context ? [context, before, after] : [before, after, ...rows.filter((line) => line.kind === "context").slice(0, 1)];
      }
      for (const line of visible) {
        const text = h("span", { class: "code-line-text" });
        for (const token of codeTokens(line.text, path)) text.append(h("span", { class: `code-token-${token.kind}`, text: token.text }));
        code.append(h("div", { class: `code-line ${line.kind}` },
          h("span", { class: "code-line-number", text: line.number && line.number > 0 ? String(line.number) : "" }),
          h("span", { class: "code-line-sign", text: line.kind === "added" ? "+" : line.kind === "removed" ? "−" : "" }), text));
      }
      if (!rows.length) code.append(h("span", { class: "peek-message", text: history.at(-1) ?? "" }));
    },
  };
}
