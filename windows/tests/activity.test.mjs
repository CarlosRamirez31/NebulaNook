import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { ActivityCard } from "../src/views/activity.ts";
import { DEFAULT_SETTINGS, State } from "../src/core/state.ts";
import { fromEdit, makeDiffStep } from "../src/core/diff.ts";
import { installFakeDom } from "./fakedom.mjs";

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
  assert.equal(card.el.find(".tracking-stage").length, 4, "the reference rail contains Read, Edit, Bash and Done");
  assert.equal(card.el.querySelector(".terminal-pass").textContent, "PASS");
  assert.match(card.el.querySelector(".terminal-output").textContent, /PASS tests\/invoice.test.ts/);
  assert.equal(card.el.find(".code-line").filter((line) => line.classList.contains("added"))[0].querySelector(".code-line-number").textContent, "12");
  assert.ok(card.el.querySelector(".code-token-keyword"));
  assert.ok(card.el.querySelector(".code-token-number"));
  assert.equal(card.el.find(".tracking-stage").at(-1).classList.contains("completed"), true);
});

test("an edit in progress keeps the previously read full file instead of replacing it with a snippet", () => {
  const path = "/project/invoice.ts";
  State.appendStep(task.id, "Read · invoice.ts");
  State.setActivityDetail(task.id, { tool: "Read", phase: "read", completed: true,
    file: { path, content: "import x from './types'\n\nconst TVA = 0.196" } });
  State.appendStep(task.id, "Edit · invoice.ts");
  State.setActivityDetail(task.id, { tool: "Edit", phase: "edit", completed: false,
    file: { path, content: "const TVA = 0.196", startLine: 0 } });
  card.sync(task);
  assert.match(card.el.querySelector(".tracking-code").textContent, /import x from/);
  assert.match(card.el.querySelector(".tracking-code").textContent, /const TVA = 0.196/);
  assert.equal(card.el.querySelector(".added"), null, "a requested edit must not be displayed as applied");
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
