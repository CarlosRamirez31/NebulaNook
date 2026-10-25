import { State, type AgentTask } from "../core/state";
import { codeTokens, historyPreview, previewLines } from "../core/code-preview";
import { agentName } from "../island/agents";
import { clear, h, svg } from "./dom";
import { language, tl } from "../i18n/i18n";

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
      const phase = done ? "done" : detail?.phase ?? "other";
      const key = `${language()}~${task.id}~${history.length}~${phase}~${detail?.completed}`;
      if (key === rendered) return;
      rendered = key;
      project.textContent = task.name;
      agent.textContent = task.id.startsWith("agent_") ? agentName(task.id.slice(6)) : "Claude Code";
      const step = ["read", "edit", "bash", "done"].indexOf(phase);
      count.textContent = step >= 0 ? `${step + 1}/4` : `${history.length}/${history.length}`;
      action.textContent = phase === "read" ? "Read" : phase === "edit" ? String(tl("Edit")) : phase === "bash" ? "Bash" : phase === "done" ? String(tl("Done")) : detail?.tool ?? "";
      const { file, diff } = historyPreview(task, State.sessionDiffs.get(task.id) ?? []);
      const path = file?.path ?? diff?.path ?? "";
      const relative = task.sessionCwd && path.startsWith(`${task.sessionCwd}/`) ? path.slice(task.sessionCwd.length + 1) : path;
      target.textContent = phase === "bash" ? detail?.command || relative : relative;
      target.title = path;
      clear(code);
      const rows = previewLines(file, diff);
      const changed = rows.findIndex((line) => line.kind !== "context");
      const start = changed >= 0 ? Math.max(0, changed - 1) : Math.max(0, rows.findIndex((line) => line.text.trim()));
      for (const line of rows.slice(start, start + 3)) {
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
