import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { buildActivityPeek } from "../src/views/activity-peek.ts";
import { DEFAULT_SETTINGS, State } from "../src/core/state.ts";
import { installFakeDom } from "./fakedom.mjs";

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
  assert.equal(peek.el.querySelector(".peek-count").textContent, "1/4");
  assert.deepEqual(peek.el.find(".code-line-number").map((line) => line.textContent), ["12", "13", "14"]);
  assert.equal(State.activityExpanded, false);
  assert.equal(opened, 0);
});

test("progress never enlarges the small card; an explicit click does", () => {
  peek.sync(task);
  State.appendStep(task.id, "Edit · invoice.ts");
  State.setActivityDetail(task.id, { tool: "Edit", phase: "edit", completed: false });
  peek.sync(task);
  assert.equal(peek.el.querySelector(".peek-count").textContent, "2/4");
  assert.equal(opened, 0);
  assert.equal(State.activityExpanded, false);
  peek.el.fire("click");
  assert.equal(opened, 1);
  assert.equal(State.activityExpanded, true);
  assert.equal(task.history.length, 2);
});
