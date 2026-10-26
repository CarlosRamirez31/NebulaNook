import { State, type ActivityDetail, type AgentTask } from "../core/state";
import { parseDiffStep } from "../core/diff";
import { fileName } from "../core/diff";
import { activityFiles, codeTokens, historyPreview, previewLines, terminalHistory } from "../core/code-preview";
import { clear, h, svg } from "./dom";
import { ICONS } from "./icons";
import { language, t, tl } from "../i18n/i18n";
import { commandTabName, isTestRun, terminalOutput } from "./terminal";

function detailPhase(detail?: ActivityDetail, step = ""): string {
  if (detail?.phase === "bash" && isTestRun(detail.command, detail.output)) return "test";
  return detail?.phase ?? (parseDiffStep(step) ? "edit" : "other");
}

/** Complete, browsable activity. Closing a diff returns to the list; X discards it. */
export class ActivityCard {
  readonly el: HTMLElement;
  private body = h("div", { class: "activity-content" });
  private count = h("span", { class: "activity-count" });
  private previous: HTMLButtonElement;
  private next: HTMLButtonElement;
  private task: AgentTask | null = null;
  private selection = -1;
  private terminalSelection: number | null = null;
  private section: string | null = null;
  private following = true;
  private detail = true;
  private rendered = "";
  private record: string[] | undefined;
  private project = h("button", { class: "activity-list-toggle", title: tl("History") });
  private stages = h("div", { class: "tracking-stages" });
  private phaseButtons = new Map<string, HTMLButtonElement>();
  private hooks: { dismiss(id: string): void; open(path: string): void; fold?(): void };

  constructor(hooks: { dismiss(id: string): void; open(path: string): void; fold?(): void }) {
    this.hooks = hooks;
    const move = (delta: number) => {
      const history = this.task?.history ?? [];
      this.selection = Math.max(0, Math.min(history.length - 1, this.selection + delta));
      this.following = false;
      this.section = null;
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
    for (const [phase, label] of [["read", "Read"], ["edit", tl("Edit")], ["bash", "Bash"], ["test", tl("Tests")], ["done", tl("Done")]] as const) {
      const button = h("button", { class: "tracking-stage", onclick: () => {
        const history = this.task?.history ?? [];
        let index = history.length - 1;
        if (phase !== "done") while (index >= 0 && detailPhase(this.task?.historyDetails?.[index], history[index]) !== phase) index--;
        if (index < 0) return;
        this.section = phase; this.terminalSelection = null;
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
        h("div", { class: "tracking-identity" }, this.project), this.stages,
        h("div", { class: "activity-head" }, this.previous, this.count, this.next, fold, dismiss)), this.body);

  }

  sync(task: AgentTask) {
    if (task.id !== this.task?.id || task.history !== this.record) {
      this.selection = -1;
      this.terminalSelection = null;
      this.section = null;
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
    this.section = null;
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
    const details = Object.values(task.historyDetails ?? {});
    const done = task.turnFinished || task.sessionEnded || task.state === "finished";
    const active = done ? "done" : detailPhase(details.filter((detail) => detail.phase !== "other").at(-1));
    const viewing = this.section ?? detailPhase(task.historyDetails?.[this.selection], history[this.selection] ?? "");
    for (const [phase, button] of this.phaseButtons) {
      const last = details.filter((detail) => detailPhase(detail) === phase).at(-1);
      const seen = !!last || (phase === "edit" && history.some((step) => parseDiffStep(step)));
      const completed = !!done && (phase === "done" || seen) && !last?.failed;
      const pending = !done && seen && phase !== active;
      button.classList.toggle("completed", !!completed);
      button.classList.toggle("active", phase === active && !done && !last?.failed);
      button.classList.toggle("pending", pending && !last?.failed);
      button.setAttribute("title", last?.failed ? t("Failed") : completed ? t("Done") : pending ? t("Pending") : phase === active ? t("Working") : t("Pending"));
      button.classList.toggle("viewing", !this.following && phase === viewing);
      button.classList.toggle("is-failed", !!last?.failed);
      const icon = button.querySelector(".tracking-stage-icon")!;
      icon.textContent = last?.failed ? "!" : completed ? "✓" : pending ? "·" : phase === "bash" ? "▣" : "";
    }
    const terminals = terminalHistory(task, this.selection);
    const selectedDetail = task.historyDetails?.[this.selection];
    const zone = this.section ?? (this.following && done ? "done" : detailPhase(selectedDetail, history[this.selection] ?? ""));
    // Keep a historical editor's DOM and scroll position while unrelated steps
    // arrive. The counter and live phase indicators above still update.
    const progress = this.detail
      ? `${selectedDetail?.completed}~${selectedDetail?.failed}~${terminals.slice(-20).map((entry) => `${entry.command}:${entry.output}:${entry.failed}`).join("~")}`
      : `${task.state}~${history.length}~${details.filter((detail) => detail.completed).length}`;
    const key = `${language()}~${task.id}~${this.selection}~${this.detail}~${zone}~${progress}`;
    if (key === this.rendered) return;
    this.rendered = key;
    clear(this.body);
    if (this.detail && (zone === "bash" || zone === "test")) {
      this.renderTerminal(terminals.filter((entry) => entry.phase === "bash" && isTestRun(entry.command, entry.output) === (zone === "test")), zone === "test");
      return;
    }
    if (this.detail && zone === "done") {
      this.body.append(h("div", { class: "tracking-editor diff-card" }, h("div", { class: "tracking-code" },
        terminalOutput(task.finalLine || history.at(-1) || t("No detail available."), task.state === "error"))));
      return;
    }
    const phase = zone === "read" || zone === "edit" ? zone : undefined;
    const { file, diff, requested } = historyPreview(task, State.sessionDiffs.get(task.id) ?? [], this.selection, phase);
    if (this.detail && phase && !file && !diff) {
      if (phase === "read") {
        const reads = terminalHistory(task, this.selection).filter((entry) => entry.phase === "read");
        if (reads.length) { this.renderTerminal(reads, false); return; }
      }
      this.body.append(h("div", { class: "tracking-editor diff-card" },
        h("div", { class: "tracking-code" }, terminalOutput(t("No detail available.")))));
      return;
    }
    if (this.detail && (file || diff)) {
      const path = file?.path ?? diff?.path ?? "";
      const relative = task.sessionCwd && path.startsWith(`${task.sessionCwd}/`) ? path.slice(task.sessionCwd.length + 1) : path;
      const tabs = h("div", { class: "tracking-file-tabs" });
      for (const entry of activityFiles(task, State.sessionDiffs.get(task.id) ?? [], undefined, phase)) {
        const ext = entry.path.split(".").at(-1)?.toLowerCase() ?? "";
        const selected = entry.path === path;
        tabs.append(h("button", { class: `tracking-file-tab${selected ? " selected" : ""}`, title: selected && requested ? `${entry.path} · ${t("Requested changes")}` : entry.path, onclick: () => {
          this.selection = entry.index; this.terminalSelection = null; this.following = false; this.detail = true; this.rendered = ""; this.render();
        } }, h("span", { class: `tracking-language lang-${ext}`, text: ext.slice(0, 4).toUpperCase() || "FILE" }),
        h("span", { text: fileName(entry.path) }), selected && diff ? h("span", { class: "tracking-edit-dot" }) : null));
      }
      const code = h("div", { class: "tracking-code" });
      const preview = previewLines(file, diff, requested);
      const rows = phase === "edit" ? preview.filter((line) => line.kind !== "context") : preview;
      for (const line of rows) {
        const text = h("span", { class: "code-line-text" });
        for (const token of codeTokens(line.text, path)) text.append(h("span", { class: `code-token-${token.kind}`, text: token.text }));
        code.append(h("div", { class: `code-line ${line.kind}` },
          h("span", { class: "code-line-number", text: line.number != null && line.number > 0 ? String(line.number) : "" }),
          h("span", { class: "code-line-sign", text: line.kind === "added" ? "+" : line.kind === "removed" ? "−" : "" }), text));
      }
      if (!rows.length) code.append(h("div", { class: "diff-note", text: t("No detail available.") }));
      const editor = h("div", { class: "tracking-editor diff-card" },
        h("div", { class: "tracking-filebar" }, tabs, h("button", { class: "tracking-file-path", title: path, text: relative,
          onclick: () => this.hooks.open(path) })), code);
      this.body.append(editor);
      tabs.querySelector(".selected")?.scrollIntoView({ block: "nearest", inline: "nearest" });
      const firstChanged = rows.findIndex((line) => line.kind !== "context");
      if (firstChanged > 3) code.scrollTop = (firstChanged - 3) * 18;
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
          this.section = null;
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

  private renderTerminal(entries: ActivityDetail[], tests: boolean) {
    const commands = h("div", { class: "tracking-file-tabs terminal-command-tabs", role: "tablist", title: tl("History") });
    const output = h("section", { class: "tracking-code tracking-terminal terminal-entry terminal-current-output" });
    const buttons: HTMLButtonElement[] = [];
    const show = (index: number) => {
      const entry = entries[index];
      if (!entry) return;
      clear(output);
      buttons.forEach((button, position) => {
        button.classList.toggle("selected", position === index);
        button.setAttribute("aria-selected", String(position === index));
      });
      if (!tests && entry.command) output.append(h("div", { class: "terminal-command", text: `$ ${entry.command}` }));
      output.append(terminalOutput(entry.output ?? "", entry.failed));
      output.scrollTop = 0;
      buttons[index]?.scrollIntoView({ block: "nearest", inline: "nearest" });
    };
    for (const [index, entry] of entries.entries()) {
      const button = h("button", { class: "tracking-file-tab terminal-command-tab", role: "tab", title: entry.command ?? entry.tool,
        onclick: () => { this.following = false; this.terminalSelection = index; show(index); } },
        svg(ICONS.terminal, 11, { stroke: 1.5 }), h("span", { text: commandTabName(entry.command ?? entry.tool) }));
      buttons.push(button);
      commands.append(button);
    }
    commands.addEventListener("wheel", (event) => {
      if (commands.scrollWidth <= commands.clientWidth) return;
      commands.scrollLeft += event.deltaX || event.deltaY;
      event.preventDefault();
    }, { passive: false });
    show(this.terminalSelection == null ? entries.length - 1 : Math.min(this.terminalSelection, entries.length - 1));
    if (!entries.length) output.append(terminalOutput(t("No detail available.")));
    this.body.append(h("div", { class: "tracking-editor diff-card terminal-only" },
      h("div", { class: "tracking-filebar" }, commands), output));
    commands.querySelector(".selected")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }
}
