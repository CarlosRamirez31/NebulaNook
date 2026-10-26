import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { buildActivityPeek } from "../src/views/activity-peek.ts";
import { DEFAULT_SETTINGS, State } from "../src/core/state.ts";
import { installFakeDom } from "./fakedom.mjs";
import { fromEdit } from "../src/core/diff.ts";

let task, peek, opened;
beforeEach(() => {
  installFakeDom();
  State.settings = { ...DEFAULT_SETTINGS };
  State.tasks = [];
  State.activityExpanded = false;
  State.loadIntegrationTasks();
  task = State.tasks.find((task) => task.id === "integration_claude");
  task.name = "korus";
  task.sessionCwd = "/project";
  State.appendStep(task.id, "Read · invoice.ts");
  State.setActivityDetail(task.id, { tool: "Read", phase: "read", completed: true,
    file: { path: "/project/src/invoice.ts", content: "export function total(items) {\n  const sum = items.reduce()\n  return sum * TVA\n}", startLine: 12 } });
  opened = 0;
  peek = buildActivityPeek(() => { opened++; State.activityExpanded = true; });
});

test("the default small card matches the reference identity, tool, counter and three numbered lines", () => {
  peek.sync(task);
  assert.equal(peek.el.querySelector(".peek-project").textContent, "korus");
  assert.equal(peek.el.querySelector(".peek-agent").textContent, "Claude Code");
  assert.equal(peek.el.querySelector(".peek-action").textContent, "Read");
  assert.equal(peek.el.querySelector(".peek-file").textContent, "src/invoice.ts");
  assert.equal(peek.el.querySelector(".peek-count").textContent, "1/5");
  assert.deepEqual(peek.el.find(".code-line-number").map((line) => line.textContent), ["12", "13", "14"]);
  assert.equal(State.activityExpanded, false);
  assert.equal(opened, 0);
});

test("progress never enlarges the small card; an explicit click does", () => {
  peek.sync(task);
  State.appendStep(task.id, "Edit · invoice.ts");
  State.setActivityDetail(task.id, { tool: "Edit", phase: "edit", completed: false });
  peek.sync(task);
  assert.equal(peek.el.querySelector(".peek-count").textContent, "2/5");
  assert.equal(opened, 0);
  assert.equal(State.activityExpanded, false);
  peek.el.fire("click");
  assert.equal(opened, 1);
  assert.equal(State.activityExpanded, true);
  assert.equal(task.history.length, 2);
});

test("small Bash and Done show actual command output and refresh as test results arrive", () => {
  State.appendStep(task.id, "dotnet test");
  State.setActivityDetail(task.id, { tool: "Shell", phase: "bash", completed: false, command: "dotnet test", output: "Running tests..." });
  peek.sync(task);
  assert.match(peek.el.querySelector(".peek-code").textContent, /dotnet test/);
  assert.match(peek.el.querySelector(".peek-code").textContent, /Running tests/);
  State.setActivityDetail(task.id, { tool: "Shell", phase: "bash", completed: true, command: "dotnet test",
    output: "Passed! - Failed: 0, Passed: 48, Total: 48" });
  State.appendStep(task.id, "git diff --check");
  State.setActivityDetail(task.id, { tool: "Shell", phase: "bash", completed: true, command: "git diff --check", output: "" });
  State.updateTask(task.id, "finished");
  peek.sync(task);
  assert.equal(peek.el.querySelector(".peek-action").textContent, "Done");
  assert.equal(peek.el.querySelector(".peek-count").textContent, "5/5");
  assert.match(peek.el.querySelector(".peek-code").textContent, /Passed: 48/);
  assert.doesNotMatch(peek.el.querySelector(".peek-code").textContent, /function total/);
  assert.ok(peek.el.querySelector(".terminal-pass"));
  assert.equal(State.activityExpanded, false);
});

test("Node's timing and skipped footer never replace its real pass/fail totals", () => {
  State.appendStep(task.id, "node --test");
  State.setActivityDetail(task.id, { tool: "Shell", phase: "bash", completed: true, command: "node --test",
    output: "✔ tests/todo.test.mjs\nℹ tests 3\nℹ pass 3\nℹ fail 0\nℹ cancelled 0\nℹ skipped 0\nℹ todo 0\nℹ duration_ms 12.67" });
  State.updateTask(task.id, "finished");
  peek.sync(task);
  assert.match(peek.el.querySelector(".peek-code").textContent, /ℹ pass 3/);
  assert.match(peek.el.querySelector(".peek-code").textContent, /ℹ fail 0/);
  assert.doesNotMatch(peek.el.querySelector(".peek-code").textContent, /duration_ms/);
});

test("small multiline edits always show both the old and new code", () => {
  const oldCode = "old one\nold two\nold three\nold four";
  const newCode = "new one\nnew two\nnew three\nnew four";
  State.appendStep(task.id, "Edit · invoice.ts");
  State.setActivityDetail(task.id, { tool: "Edit", phase: "edit", completed: false,
    file: { path: "/project/src/invoice.ts", content: oldCode },
    requestedDiff: fromEdit(oldCode, newCode, "/project/src/invoice.ts") });
  peek.sync(task);
  assert.match(peek.el.querySelector(".removed").textContent, /old one/);
  assert.match(peek.el.querySelector(".added").textContent, /new one/);
  assert.ok(peek.el.find(".code-line").length <= 3);
});
