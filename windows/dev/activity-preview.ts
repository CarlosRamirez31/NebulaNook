// Visual QA fixture from docs/media/demo.gif; never included in the application.
import "../src/style.css";
import { Island } from "../src/island/island";
import { DEFAULT_SETTINGS, State } from "../src/core/state";
import { fromEdit, makeDiffStep } from "../src/core/diff";
import { setLanguage } from "../src/i18n/i18n";

setLanguage("en");
State.settings = { ...DEFAULT_SETTINGS, soundEnabled: false, mochiOutfit: "none", openOnHover: false };
State.loadIntegrationTasks();
const island = new Island(document.getElementById("root")!);
const path = "src/invoice.ts";
const oldText = "import { Item } from './types'\n\nconst TVA = 0.196\n\nexport function total(items: Item[]) {\n  const sum = items.reduce((s, i) => s + i.price, 0)\n  return sum * (1 + TVA)\n}";
const newText = oldText.replace("0.196", "0.20  // 2026").replace("return sum * (1 + TVA)", "return Math.round(sum * (1 + TVA) * 100) / 100");

function seed(stage: string) {
  const task = State.tasks.find((t) => t.id === "integration_claude")!;
  State.dismissHistory(task.id);
  task.name = "korus";
  task.sessionCwd = "/project";
  State.updateTask(task.id, "working");
  State.appendStep(task.id, "Read · invoice.ts");
  State.setActivityDetail(task.id, { tool: "Read", phase: "read", completed: true, file: { path, content: oldText, startLine: 10 } });
  if (stage !== "read") {
    State.appendStep(task.id, "Edit · invoice.ts");
    State.setActivityDetail(task.id, { tool: "Edit", phase: "edit", completed: false, file: { path, content: oldText, startLine: 10 },
      requestedDiff: stage === "edit" ? fromEdit(oldText, newText, path) : undefined });
  }
  if (stage === "bash" || stage === "done") {
    const diff = fromEdit(oldText, newText, path);
    const id = State.appendSessionDiff(task.id, diff);
    State.appendStep(task.id, makeDiffStep("invoice.ts", diff.added, diff.removed, id));
    State.setActivityDetail(task.id, { tool: "Edit", phase: "edit", completed: true, file: { path, content: newText, startLine: 10 } });
    State.appendStep(task.id, "Bash · npm test");
    State.setActivityDetail(task.id, { tool: "Bash", phase: "bash", completed: stage === "done", command: "npm test", output: stage === "done" ? "PASS  tests/invoice.test.ts\nTests: 48 passed, 48 total" : "Running tests/invoice.test.ts" });
  }
  if (stage === "done") {
    State.appendStep(task.id, "Updated the tax rate and rounded the total.");
    State.updateTask(task.id, "finished");
  }
  State.setFocus(task.id);
  State.notify();
}

const query = new URLSearchParams(location.search);
seed(query.get("stage") ?? "bash");
if (query.get("size") === "small" && query.get("stage") === "read") {
  State.setActivityDetail("integration_claude", { tool: "Read", phase: "read", completed: true,
    file: { path, content: "export function total(items: Item[]) {\n  const sum = items.reduce((s, i) => s + i.price, 0)\n  return sum * (1 + TVA)\n}", startLine: 12 } });
}
island.fsm.forcePetit();
if (query.get("expanded") === "1") island.fsm.forceHome();
if (query.get("expanded") === "1" && query.get("size") !== "small") island.expandActivity();
const tab = query.get("tab");
if (tab === "prompt" || tab === "settings" || tab === "upload") {
  island.setView(tab);
  island.showFileDiff(null); // A real background event must not take this tab away.
}
// Deterministic offscreen rendering: advance the real springs before a browser
// screenshot, without adding delays or changing production animation timings.
if (query.get("expanded") === "1") {
  const frame = island as unknown as { frame(now: number): void; lastFrame: number };
  const schedule = window.requestAnimationFrame;
  window.requestAnimationFrame = () => 0;
  const start = performance.now();
  for (let index = 1; index <= 120; index++) frame.frame(start + index * 16);
  frame.lastFrame = performance.now();
  window.requestAnimationFrame = schedule;
  const errors = [];
  if (tab) {
    if (State.view !== tab) errors.push("background update replaced selected tab");
    if (State.focusTask?.state !== "working") errors.push("tab navigation changed running task");
  } else if (query.get("size") === "small") {
    const peek = document.querySelector<HTMLElement>(".activity-peek")!;
    const body = peek.querySelector<HTMLElement>(".peek-code")!;
    if (peek.querySelectorAll(".code-line").length !== 3) errors.push("missing preview lines");
    if (body.lastElementChild!.getBoundingClientRect().bottom > body.getBoundingClientRect().bottom) errors.push("small code clipped");
    if (State.activityExpanded) errors.push("preview expanded without click");
  } else {
    const editor = document.querySelector<HTMLElement>(".tracking-editor")!;
    const footer = document.querySelector<HTMLElement>(".activity-head")!;
    const done = document.querySelectorAll<HTMLElement>(".tracking-stage")[3];
    const body = document.querySelector<HTMLElement>(".tracking-code")!;
    if (done.getBoundingClientRect().bottom > footer.getBoundingClientRect().top) errors.push("overlapping controls");
    if (editor.getBoundingClientRect().right > document.querySelector("#island")!.getBoundingClientRect().right) errors.push("editor clipped");
    if (body.lastElementChild!.getBoundingClientRect().bottom > body.getBoundingClientRect().bottom) errors.push("reference code clipped");
  }
  const status = document.createElement("span");
  status.style.color = errors.length ? "#ff8d97" : "#34d399";
  status.textContent = errors.length ? `QA FAIL: ${errors.join(", ")}` : `QA PASS: ${query.get("stage") ?? "bash"}`;
  document.querySelector("#preview-controls")!.append(status);
}
for (const button of document.querySelectorAll<HTMLButtonElement>("[data-stage]")) {
  button.addEventListener("click", () => seed(button.dataset.stage!));
}
