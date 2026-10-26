import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { ActivityCard } from "../src/views/activity.ts";
import { DEFAULT_SETTINGS, State } from "../src/core/state.ts";
import { fromEdit, makeDiffStep } from "../src/core/diff.ts";
import { installFakeDom } from "./fakedom.mjs";
import { commandTabName } from "../src/views/terminal.ts";

let task, card, dismissed;
const addEdit = (path) => {
  const id = State.appendSessionDiff(task.id, fromEdit(`old ${path}`, `new ${path}`, path));
  State.appendStep(task.id, makeDiffStep(path, 1, 1, id));
  return id;
};

beforeEach(() => {
  const dom = installFakeDom();
  document.createDocumentFragment = dom.root;
  State.settings = { ...DEFAULT_SETTINGS };
  State.tasks = [];
  State.sessionDiffs.clear();
  State.loadIntegrationTasks();
  task = State.tasks.find((t) => t.id === "integration_claude");
  dismissed = [];
  card = new ActivityCard({ dismiss(id) { dismissed.push(id); State.dismissHistory(id); }, open() {} });
});

test("completed history lists all edited files and navigates their actual diffs", () => {
  for (const path of ["one.md", "two.json", "three.txt"]) addEdit(path);
  task.state = "idle";
  card.sync(task);
  card.el.querySelector(".activity-list-toggle").fire("click");
  for (const path of ["one.md", "two.json", "three.txt"]) assert.match(card.el.textContent, new RegExp(path));
  card.el.find(".activity-row")[1].fire("click");
  assert.match(card.el.querySelector(".diff-card").textContent, /two.json/);
  assert.match(card.el.querySelector(".diff-card").textContent, /old two.json/);
  assert.match(card.el.querySelector(".diff-card").textContent, /new two.json/);
  const previous = card.el.find(".icon-btn").find((button) => button.getAttribute("title") === "Previous");
  const next = card.el.find(".icon-btn").find((button) => button.getAttribute("title") === "Next");
  previous.fire("click");
  assert.match(card.el.querySelector(".diff-card").textContent, /one.md/);
  next.fire("click");
  assert.match(card.el.querySelector(".diff-card").textContent, /two.json/);
  card.el.querySelector(".activity-list-toggle").fire("click");
  assert.equal(card.el.find(".activity-row").length, 3);
});

test("the reference editor shows numbered syntax, real changes, phase status and terminal output", () => {
  const path = "invoice.ts";
  const id = State.appendSessionDiff(task.id, fromEdit("const TVA = 0.196", "const TVA = 0.20", path));
  State.appendStep(task.id, makeDiffStep(path, 1, 1, id));
  State.setActivityDetail(task.id, { tool: "Edit", phase: "edit", completed: true, file: { path, content: "import x from './types'\n\nconst TVA = 0.20", startLine: 10 } });
  State.appendStep(task.id, "Runs · npm test");
  State.setActivityDetail(task.id, { tool: "Bash", phase: "bash", completed: true, command: "npm test", output: "\u001b[32mPASS\u001b[0m tests/invoice.test.ts" });
  State.updateTask(task.id, "finished");
  card.sync(task);
  assert.ok(card.el.querySelector(".tracking-sidebar"));
  assert.equal(card.el.find(".tracking-stage").length, 5, "Read, Edit, Bash, Tests and Done have separate zones");
  card.el.find(".tracking-stage")[3].fire("click");
  assert.equal(card.el.querySelector(".terminal-pass").textContent, "PASS");
  assert.match(card.el.querySelector(".terminal-output").textContent, /PASS tests\/invoice.test.ts/);
  assert.equal(card.el.querySelector(".code-line"), null);
  card.el.find(".tracking-stage")[1].fire("click");
  assert.equal(card.el.querySelector(".tracking-terminal"), null);
  assert.equal(card.el.find(".code-line").filter((line) => line.classList.contains("added"))[0].querySelector(".code-line-number").textContent, "12");
  assert.ok(card.el.querySelector(".code-token-keyword"));
  assert.ok(card.el.querySelector(".code-token-number"));
  assert.equal(card.el.find(".tracking-stage").at(-1).classList.contains("completed"), true);
});

test("Read keeps the full file while Edit shows only changed lines", () => {
  const path = "/project/invoice.ts";
  State.appendStep(task.id, "Read · invoice.ts");
  State.setActivityDetail(task.id, { tool: "Read", phase: "read", completed: true,
    file: { path, content: "import x from './types'\n\nconst TVA = 0.196" } });
  State.appendStep(task.id, "Edit · invoice.ts");
  State.setActivityDetail(task.id, { tool: "Edit", phase: "edit", completed: false,
    file: { path, content: "const TVA = 0.196", startLine: 0 },
    requestedDiff: fromEdit("const TVA = 0.196", "const TVA = 0.20", path) });
  card.sync(task);
  assert.doesNotMatch(card.el.querySelector(".tracking-code").textContent, /import x from/);
  assert.match(card.el.querySelector(".tracking-code").textContent, /const TVA = 0.196/);
  assert.match(card.el.querySelector(".tracking-code").textContent, /const TVA = 0.20/);
  assert.equal(card.el.find(".context").length, 0);
  card.el.find(".tracking-stage")[0].fire("click");
  assert.match(card.el.querySelector(".tracking-code").textContent, /import x from/);
  assert.equal(card.el.querySelector(".added"), null);
});

test("phases stay active between tool calls and pending when work moves on until Stop", () => {
  task.state = "working";
  State.appendStep(task.id, "Read · a.ts");
  State.setActivityDetail(task.id, { tool: "Read", phase: "read", completed: true });
  card.sync(task);
  let [read, edit, , , done] = card.el.find(".tracking-stage");
  assert.equal(read.classList.contains("active"), true);
  assert.equal(read.classList.contains("completed"), false);
  State.appendStep(task.id, "Edit · a.ts");
  State.setActivityDetail(task.id, { tool: "Edit", phase: "edit", completed: false });
  card.sync(task);
  assert.equal(read.classList.contains("pending"), true);
  assert.equal(read.classList.contains("active"), false);
  assert.equal(edit.classList.contains("active"), true);
  State.appendStep(task.id, "Read · b.ts");
  State.setActivityDetail(task.id, { tool: "Read", phase: "read", completed: true });
  card.sync(task);
  assert.equal(read.classList.contains("active"), true);
  assert.equal(edit.classList.contains("pending"), true);
  State.updateTask(task.id, "finished");
  card.sync(task);
  assert.equal(read.classList.contains("completed"), true);
  assert.equal(edit.classList.contains("completed"), true);
  assert.equal(done.classList.contains("completed"), true);
  assert.equal(edit.classList.contains("pending"), false);
});

test("an envelope's patch preview is labelled as requested rather than an applied diff", () => {
  State.appendStep(task.id, "Edits · a.ts");
  State.setActivityDetail(task.id, { tool: "apply_patch", phase: "edit", completed: false,
    requestedDiff: fromEdit("old code", "requested code", "a.ts") });
  card.sync(task);
  assert.match(card.el.querySelector(".tracking-file-tab").getAttribute("title"), /Requested changes/);
  assert.match(card.el.querySelector(".tracking-code").textContent, /old code/);
  assert.match(card.el.querySelector(".tracking-code").textContent, /requested code/);
  assert.equal(State.sessionDiffs.get(task.id)?.length ?? 0, 0);
});

test("file, command and test tabs stay confined to their own selected zone", () => {
  addEdit("first.cs");
  addEdit("second.cs");
  for (const [command, output] of [["dotnet build", "Build succeeded."], ["dotnet test", "Passed! - Failed: 0, Passed: 3, Total: 3"]]) {
    State.appendStep(task.id, command);
    State.setActivityDetail(task.id, { tool: "Shell", phase: "bash", command, output, completed: true });
  }
  card.sync(task);
  assert.equal(card.el.querySelector(".code-line"), null);
  card.el.find(".tracking-stage")[1].fire("click");
  const fileTabs = () => card.el.querySelector(".tracking-filebar").find(".tracking-file-tab");
  assert.equal(fileTabs().length, 2);
  assert.equal(card.el.querySelector(".tracking-terminal"), null);
  fileTabs()[0].fire("click");
  assert.match(card.el.querySelector(".tracking-code").textContent, /new first.cs/);
  assert.equal(fileTabs().length, 2, "switching tabs keeps other files reachable");
  fileTabs()[1].fire("click");
  assert.match(card.el.querySelector(".tracking-code").textContent, /new second.cs/);
  card.el.find(".tracking-stage")[2].fire("click");
  assert.match(card.el.querySelector(".terminal-output").textContent, /Build succeeded/);
  assert.equal(card.el.querySelector(".code-line"), null);
  assert.doesNotMatch(card.el.querySelector(".terminal-output").textContent, /Passed: 3/);
  assert.equal(card.el.find(".terminal-command-tab").length, 1);
  card.el.find(".tracking-stage")[3].fire("click");
  assert.match(card.el.querySelector(".terminal-output").textContent, /Passed: 3/);
  assert.doesNotMatch(card.el.querySelector(".terminal-output").textContent, /Build succeeded/);
  assert.equal(card.el.querySelector(".terminal-command"), null);
});

test("command tabs show script basenames while keeping the full command in the tooltip", () => {
  for (const [command, label] of [
    ["python3 /tmp/todo-net10-layers.py", "todo-net10-layers.py"],
    ['bash "/tmp/my script.sh"', "my script.sh"],
    ["node --import ./tests/setup.mjs --test tests/activity.test.mjs", "activity.test.mjs"],
    ["dotnet test", "dotnet test"],
    ["npm run build", "npm run build"],
    ["python3 -c 'print(42)'", "python3"],
  ]) assert.equal(commandTabName(command), label);
  State.appendStep(task.id, "python3 /tmp/scripts/check.py");
  State.setActivityDetail(task.id, { tool: "Bash", phase: "bash", command: "python3 /tmp/scripts/check.py", output: "done", completed: true });
  card.sync(task);
  const tab = card.el.querySelector(".terminal-command-tab");
  assert.equal(tab.textContent, "check.py");
  assert.equal(tab.getAttribute("title"), "python3 /tmp/scripts/check.py");
  assert.equal(card.el.querySelector(".terminal-command-tabs").getAttribute("role"), "tablist");
});

test("overflowing command tabs scroll horizontally without changing the selected output", () => {
  for (let index = 0; index < 20; index++) {
    const command = `python3 /tmp/scripts/check-${index}.py`;
    State.appendStep(task.id, command);
    State.setActivityDetail(task.id, { tool: "Bash", phase: "bash", command, output: `result ${index}`, completed: true });
  }
  card.sync(task);
  const tabs = card.el.querySelector(".terminal-command-tabs");
  tabs.scrollWidth = 2000;
  tabs.clientWidth = 300;
  tabs.scrollLeft = 0;
  const wheel = { deltaX: 0, deltaY: 140, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
  tabs.listeners.get("wheel")[0](wheel);
  assert.equal(tabs.scrollLeft, 140);
  assert.equal(wheel.defaultPrevented, true);
  assert.match(card.el.querySelector(".terminal-output").textContent, /result 19/);
  assert.equal(card.el.find(".terminal-command-tab").at(-1).getAttribute("aria-selected"), "true");
});

test("reported checkmarks render as small vector status icons", () => {
  State.appendStep(task.id, "node --test");
  State.setActivityDetail(task.id, { tool: "Shell", phase: "bash", command: "node --test", output: "✔ Tests.Todo\n✖ Tests.Error", completed: true });
  card.sync(task);
  assert.equal(card.el.find(".terminal-status").length, 2);
  assert.equal(card.el.querySelector(".is-passed").children[0].getAttribute("viewBox"), "0 0 24 24");
  assert.equal(card.el.querySelector(".is-failed").children[0].getAttribute("viewBox"), "0 0 24 24");
});

test("shell-only activity shows output instead of an empty file list", () => {
  State.appendStep(task.id, "dotnet test");
  State.setActivityDetail(task.id, { tool: "Shell", phase: "bash", command: "dotnet test", completed: true,
    failed: true, output: "Failed! - Failed: 1, Passed: 2, Total: 3" });
  card.sync(task);
  assert.ok(card.el.querySelector(".terminal-only"));
  assert.ok(card.el.querySelector(".terminal-fail"));
  assert.match(card.el.textContent, /Failed: 1, Passed: 2/);
});

test("new edits do not move a user who is reviewing an earlier step", () => {
  addEdit("old.txt");
  card.sync(task);
  card.el.querySelector(".activity-list-toggle").fire("click");
  card.el.querySelector(".activity-row").fire("click");
  const editor = card.el.querySelector(".tracking-code");
  editor.scrollTop = 80;
  const newest = addEdit("new.txt");
  card.sync(task);
  card.showDiff(newest);
  assert.match(card.el.querySelector(".diff-card").textContent, /old.txt/);
  assert.doesNotMatch(card.el.querySelector(".diff-card").textContent, /new.txt/);
  assert.equal(card.el.querySelector(".tracking-code"), editor);
  assert.equal(editor.scrollTop, 80);
  assert.equal(card.el.find(".tracking-stage")[1].classList.contains("viewing"), true);
});

test("X clears history and diffs without stopping a working agent; later work starts a fresh record", () => {
  addEdit("one.txt");
  task.state = "working";
  card.sync(task);
  card.el.querySelector(".activity-dismiss").fire("click");
  assert.deepEqual(dismissed, [task.id]);
  assert.deepEqual(task.history, []);
  assert.deepEqual(task.steps, []);
  assert.equal(task.state, "working");
  assert.equal(State.sessionDiffs.has(task.id), false);
  addEdit("after.txt");
  card.sync(task);
  assert.match(card.el.textContent, /after.txt/);
  assert.doesNotMatch(card.el.textContent, /one.txt/);
});

test("history paging reaches records older than the live ticker's twenty steps", () => {
  for (let i = 0; i < 65; i++) addEdit(`file-${i}.md`);
  card.sync(task);
  assert.equal(task.steps.length, 20);
  assert.equal(task.history.length, 65);
  card.el.querySelector(".activity-list-toggle").fire("click");
  let pages = 0;
  while (!card.el.find(".activity-row").some((row) => row.textContent.includes("file-0.md"))) {
    const previous = card.el.find(".activity-row").find((row) => row.textContent === "Previous");
    assert.ok(previous);
    previous.fire("click");
    assert.ok(++pages < 10);
  }
  const first = card.el.find(".activity-row").find((row) => row.textContent.includes("file-0.md"));
  first.fire("click");
  assert.match(card.el.querySelector(".diff-card").textContent, /old file-0.md/);
});
