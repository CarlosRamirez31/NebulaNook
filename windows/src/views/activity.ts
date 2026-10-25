import { State, type AgentTask } from "../core/state";
import { parseDiffStep } from "../core/diff";
import { fileName } from "../core/diff";
import { codeTokens, historyPreview, previewLines } from "../core/code-preview";
import { agentName } from "../island/agents";
import { clear, h, svg } from "./dom";
import { ICONS } from "./icons";
import { language, t, tl } from "../i18n/i18n";

/** Complete, browsable activity. Closing a diff returns to the list; X discards it. */
export class ActivityCard {
  readonly el: HTMLElement;
  private body = h("div", { class: "activity-content" });
  private count = h("span", { class: "activity-count" });
  private previous: HTMLButtonElement;
  private next: HTMLButtonElement;
  private task: AgentTask | null = null;
  private selection = -1;
  private following = true;
  private detail = true;
  private rendered = "";
  private record: string[] | undefined;
  private project = h("button", { class: "activity-list-toggle", title: tl("History") });
  private agent = h("div", { class: "tracking-agent" });
  private stages = h("div", { class: "tracking-stages" });
  private phaseButtons = new Map<string, HTMLButtonElement>();
  private hooks: { dismiss(id: string): void; open(path: string): void; fold?(): void };

  constructor(hooks: { dismiss(id: string): void; open(path: string): void; fold?(): void }) {
    this.hooks = hooks;
    const move = (delta: number) => {
      const history = this.task?.history ?? [];
      this.selection = Math.max(0, Math.min(history.length - 1, this.selection + delta));
      this.following = false;
      this.detail = true;
      this.rendered = "";
      this.render();
    };
    this.previous = h("button", { class: "icon-btn", title: tl("Previous"), onclick: () => move(-1) }, svg(ICONS.chevronLeft, 9));
    this.next = h("button", { class: "icon-btn", title: tl("Next"), onclick: () => move(1) }, svg(ICONS.chevronRight, 9));
    this.project.addEventListener("click", () => {
      this.detail = false;
      this.following = false;
      this.rendered = "";
      this.render();
    });
    for (const [phase, label] of [["read", "Read"], ["edit", tl("Edit")], ["bash", "Bash"], ["done", tl("Done")]] as const) {
      const button = h("button", { class: "tracking-stage", onclick: () => {
        const history = this.task?.history ?? [];
        let index = history.length - 1;
        if (phase !== "done") while (index >= 0 && this.task?.historyDetails?.[index]?.phase !== phase && !(phase === "edit" && parseDiffStep(history[index]))) index--;
        if (index < 0) return;
        this.selection = index; this.following = false; this.detail = true; this.rendered = ""; this.render();
      } }, h("span", { class: "tracking-stage-icon" }), h("span", { text: label }));
      this.phaseButtons.set(phase, button);
      this.stages.append(button);
    }
    const dismiss = h("button", { class: "icon-btn activity-dismiss", title: tl("Clear history"), onclick: () => {
      const id = this.task?.id;
      this.task = null;
      this.record = undefined;
      this.rendered = "";
      clear(this.body);
      if (id) this.hooks.dismiss(id);
    } }, svg(ICONS.xmark, 9));
    const fold = hooks.fold ? h("button", { class: "icon-btn activity-fold", title: tl("Back"), onclick: () => hooks.fold?.() }, svg(ICONS.chevronUp, 9)) : null;
    this.el = h("div", { class: "activity-card tracking-card" },
      h("aside", { class: "tracking-sidebar" },
        h("div", { class: "tracking-identity" }, this.project, this.agent), this.stages,
        h("div", { class: "activity-head" }, this.previous, this.count, this.next, fold, dismiss)), this.body);

  }

  sync(task: AgentTask) {
    if (task.id !== this.task?.id || task.history !== this.record) {
      this.selection = -1;
      this.following = true;
      this.detail = true;
      this.rendered = "";
    }
    this.task = task;
    this.record = task.history;
    if (this.following) this.selection = (task.history?.length ?? 0) - 1;
    this.render();
  }

  showDiff(id: number | null) {
    if (!this.following || !this.task) return;
    if (id == null) this.detail = true;
    else {
      const index = this.task.history?.findIndex((step) => parseDiffStep(step)?.diffId === id) ?? -1;
      if (index < 0) return;
      this.selection = index;
      this.detail = true;
    }
    this.rendered = "";
    this.render();
  }

  toggleDiff() {
    if (this.detail) this.detail = false;
    else {
      const history = this.task?.history ?? [];
      let index = history.length - 1;
      while (index >= 0 && parseDiffStep(history[index]) == null) index--;
      if (index < 0) return;
      this.selection = index;
      this.detail = true;
    }
    this.following = false;
    this.rendered = "";
    this.render();
  }

  private render() {
    const task = this.task;
    if (!task) return;
    const history = task.history ?? [];
    this.selection = Math.min(this.selection, history.length - 1);
    this.count.textContent = `${this.selection + 1}/${history.length}`;
    this.previous.disabled = this.selection <= 0;
    this.next.disabled = this.selection >= history.length - 1;
    this.project.textContent = task.name;
    this.agent.textContent = task.id.startsWith("agent_") ? agentName(task.id.slice(6)) : "Claude Code";
    const details = Object.values(task.historyDetails ?? {});
    const done = task.turnFinished || task.sessionEnded || task.state === "finished";
    const active = done ? "done" : details.at(-1)?.phase;
    const viewing = task.historyDetails?.[this.selection]?.phase ?? (parseDiffStep(history[this.selection] ?? "") ? "edit" : done ? "done" : null);
    for (const [phase, button] of this.phaseButtons) {
      const last = details.filter((detail) => detail.phase === phase).at(-1);
      const completed = phase === "done" ? !!done : last?.completed || (phase === "edit" && history.some((step) => parseDiffStep(step)));
      button.classList.toggle("completed", !!completed);
      button.classList.toggle("active", phase === active && !completed);
      button.classList.toggle("viewing", !this.following && phase === viewing);
      button.classList.toggle("is-failed", !!last?.failed);
      const icon = button.querySelector(".tracking-stage-icon")!;
      icon.textContent = completed ? "✓" : phase === "bash" ? "▣" : "";
    }
    const terminal = Object.entries(task.historyDetails ?? {}).filter(([index, detail]) => Number(index) <= this.selection && detail.phase === "bash").at(-1)?.[1];
    const selectedDetail = task.historyDetails?.[this.selection];
    // Keep a historical editor's DOM and scroll position while unrelated steps
    // arrive. The counter and live phase indicators above still update.
    const progress = this.detail
      ? `${selectedDetail?.completed}~${selectedDetail?.failed}~${terminal?.output ?? ""}`
      : `${task.state}~${history.length}~${details.filter((detail) => detail.completed).length}`;
    const key = `${language()}~${task.id}~${this.selection}~${this.detail}~${progress}`;
    if (key === this.rendered) return;
    this.rendered = key;
    clear(this.body);
    const { file, diff } = historyPreview(task, State.sessionDiffs.get(task.id) ?? [], this.selection);
    if (this.detail && (file || diff)) {
      const path = file?.path ?? diff!.path;
      const extension = path.split(".").at(-1)?.toLowerCase() ?? "";
      const relative = task.sessionCwd && path.startsWith(`${task.sessionCwd}/`) ? path.slice(task.sessionCwd.length + 1) : path;
      const fileButton = h("button", { class: "tracking-file-tab", title: tl("History"), onclick: () => {
        this.detail = false; this.following = false; this.rendered = ""; this.render();
      } }, h("span", { class: `tracking-language lang-${extension}`, text: extension.slice(0, 4).toUpperCase() || "FILE" }),
      h("span", { text: fileName(path) }), h("span", { class: "tracking-edit-dot" }));
      const code = h("div", { class: "tracking-code" });
      const rows = previewLines(file, diff);
      for (const line of rows) {
        const text = h("span", { class: "code-line-text" });
        for (const token of codeTokens(line.text, path)) text.append(h("span", { class: `code-token-${token.kind}`, text: token.text }));
        code.append(h("div", { class: `code-line ${line.kind}` },
          h("span", { class: "code-line-number", text: line.number != null && line.number > 0 ? String(line.number) : "" }),
          h("span", { class: "code-line-sign", text: line.kind === "added" ? "+" : line.kind === "removed" ? "−" : "" }), text));
      }
      if (!rows.length) code.append(h("div", { class: "diff-note", text: t("No detail available.") }));
      const editor = h("div", { class: "tracking-editor diff-card" },
        h("div", { class: "tracking-filebar" }, fileButton, h("button", { class: "tracking-file-path", title: path, text: relative,
          onclick: () => this.hooks.open(path) })), code);
      if (terminal?.command || terminal?.output) {
        const output = h("pre", { class: terminal.failed ? "terminal-output failed" : "terminal-output" });
        const plain = (terminal.output ?? "").replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
        for (const [index, line] of plain.split("\n").entries()) {
          if (index) output.append("\n");
          const result = /^(\s*)(PASS|FAIL)(\b.*)$/.exec(line);
          if (result) output.append(result[1], h("span", { class: result[2] === "PASS" ? "terminal-pass" : "terminal-fail", text: result[2] }), result[3]);
          else output.append(line);
        }
        editor.append(h("div", { class: "tracking-terminal" }, h("div", { class: "terminal-command", text: `$ ${terminal.command ?? ""}` }), output));
      }
      this.body.append(editor);
      const firstChanged = rows.findIndex((line) => line.kind !== "context");
      if (firstChanged > 3) code.scrollTop = (firstChanged - 3) * 16;
      return;
    }
    const list = h("div", { class: "activity-list" });
    // All records remain reachable, while only a small window becomes DOM.
    const start = Math.max(0, Math.min(this.selection - 10, history.length - 40));
    const end = Math.min(history.length, start + 40);
    const appendRow = (index: number) => {
      const step = history[index];
      const parsed = parseDiffStep(step);
      const file = parsed ? State.findDiff(task.id, parsed.diffId) : null;
      const text = file ? `${file.path}  +${file.added} −${file.removed}` : step;
      const row = h("button", {
        class: `activity-row${index === this.selection ? " selected" : ""}`,
        title: text,
        onclick: () => {
          this.selection = index;
          this.following = false;
          this.detail = true;
          this.rendered = "";
          this.render();
        },
      }, h("span", { class: "activity-step-number", text: String(index + 1) }),
      h("span", { text: parsed || index < history.length - 1 || ["idle", "finished", "error"].includes(task.state) ? "✓" : "›" }),
      h("span", { class: "activity-step-text", text }));
      list.append(row);
    };
    if (start > 0) list.append(h("button", { class: "activity-row", text: t("Previous"), onclick: () => {
      this.selection = Math.max(0, start - 1); this.following = false; this.rendered = ""; this.render();
    } }));
    for (let index = start; index < end; index++) appendRow(index);
    if (end < history.length) list.append(h("button", { class: "activity-row", text: t("Next"), onclick: () => {
      this.selection = end; this.following = false; this.rendered = ""; this.render();
    } }));
    this.body.append(list);
    list.querySelector(".selected")?.scrollIntoView({ block: "nearest" });
  }
}
