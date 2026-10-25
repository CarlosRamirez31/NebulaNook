import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { mock, test } from "node:test";
import assert from "node:assert/strict";
import ts from "typescript";
import { IslandStateMachine } from "../src/island/fsm.ts";
import { DEFAULT_SETTINGS, State } from "../src/core/state.ts";

// Island imports the upload animation, whose parameter properties need more
// than Node's type stripping. Keep this compatibility loader local to this test.
registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith("/src/upload/sequence.ts")) {
      const source = readFileSync(new URL(url), "utf8");
      return { format: "module", source: ts.transpileModule(source, {
        compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
      }).outputText, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});
const { Island } = await import("../src/island/island.ts");
const { buildOverview } = await import("../src/views/views.ts");
const { installFakeDom } = await import("./fakedom.mjs");
const { fromEdit } = await import("../src/core/diff.ts");

for (const pointerInside of [true, false]) {
  test(`answering closes approval immediately with pointer ${pointerInside ? "inside" : "outside"}`, () => {
    State.settings = { ...DEFAULT_SETTINGS, autoCloseInterval: 3600 };
    State.tasks = [];
    State.focusId = null;
    State.focusBeforeApproval = null;
    State.loadIntegrationTasks();
    State.mode = "expanded";
    State.view = "approval";
    State.beginApproval({ requestId: "r1", pillId: "integration_claude", sessionId: "s1", tool: "Bash", command: "ls" });

    // Exercise the real close, view and FSM wiring without starting canvases.
    const island = Object.create(Island.prototype);
    island.fsm = new IslandStateMachine();
    island.fsm.forceHome();
    island.fsm.pinned = true;
    island.wasInIsland = pointerInside;
    island.setPointerInside(pointerInside);
    island.animateGeometry = () => {};
    island.setMode = (mode) => { State.mode = mode; };
    island.wireFsm();

    island.closeApproval();

    assert.equal(State.pendingApproval, null);
    assert.equal(State.isPinned, false);
    assert.equal(island.fsm.pinned, false);
    assert.equal(island.fsm.state, "petit");
    assert.equal(State.mode, "compact");
    assert.notEqual(State.view, "approval");
    island.fsm.cancelTimers();
  });
}

test("automatic preview renders changed file text and returns to steps for the next edit", () => {
  const dom = installFakeDom();
  document.createDocumentFragment = dom.root;
  window.addEventListener = () => {};
  State.settings = { ...DEFAULT_SETTINGS };
  State.tasks = [];
  State.focusId = null;
  State.loadIntegrationTasks();
  State.setFocus("integration_claude");
  State.mode = "expanded";
  State.view = "overview";
  const overview = buildOverview({ blip() {}, openTarget() {}, openSettingsWindow() {} });
  const id = State.appendSessionDiff("integration_claude", fromEdit("antes", "después", "notas.txt"));
  overview.showDiff(id);
  overview.sync();
  const card = overview.el.querySelector(".diff-card");
  assert.ok(card, "the completed edit opens without Ctrl+E or clicking a ticker row");
  assert.match(card.textContent, /notas.txt/);
  assert.match(card.textContent, /antes/);
  assert.match(card.textContent, /después/);
  overview.showDiff(id);
  overview.sync();
  assert.ok(overview.el.querySelector(".diff-card"), "the next completion must not toggle the preview closed");
  overview.showDiff(null);
  overview.sync();
  assert.equal(overview.el.querySelector(".diff-card"), null);
  State.clearSessionDiffs("integration_claude");
});

test("agent activity opens only on hover and folds when the pointer leaves, even with a one-hour auto-close", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const island = Object.create(Island.prototype);
  try {
    State.settings = { ...DEFAULT_SETTINGS, openOnHover: false, autoCloseInterval: 3600 };
    State.tasks = [];
    State.focusId = null;
    State.pendingApproval = null;
    State.loadIntegrationTasks();
    State.setFocus("integration_claude");
    State.appendStep("integration_claude", "Edits · notes.md");
    State.mode = "compact";
    island.fsm = new IslandStateMachine();
    island.fsm.forcePetit();
    island.wasInIsland = false;
    island.pointerInside = null;
    island.islandRect = () => ({ x: 0, y: 0, w: 240, h: 6 });
    island.isBotHit = () => false;
    island.ensureRunning = () => {};
    island.expand = (view) => { State.mode = "expanded"; State.view = view; };
    island.setMode = (mode) => { State.mode = mode; };
    island.wireFsm();
    assert.equal(State.mode, "compact");
    island.onCursor(120, 3);
    assert.equal(State.mode, "expanded");
    assert.equal(State.view, "overview");
    assert.equal(island.fsm.openedByHover, true);
    island.onCursor(1000, 1000);
    mock.timers.tick(600);
    assert.equal(State.mode, "compact");
  } finally {
    island.fsm?.cancelTimers();
    mock.timers.reset();
  }
});

test("background file updates never replace the selected tab, including a hover-opened island", () => {
  const island = Object.create(Island.prototype);
  island.fsm = new IslandStateMachine();
  island.fsm.openOnHover = true;
  island.fsm.mouseEntered();
  const queued = [];
  island.views = new Map([["overview", { showDiff: (id) => queued.push(id) }]]);
  island.setView = () => assert.fail("a background edit must not navigate");
  State.mode = "expanded";
  for (const tab of ["prompt", "settings", "upload"]) {
    State.view = tab;
    island.showFileDiff(42);
    assert.equal(State.view, tab);
    assert.equal(State.mode, "expanded");
  }
  assert.deepEqual(queued, [42, 42, 42]);
  island.fsm.cancelTimers();
});

test("selecting another tab releases hover-only closing while preserving the running task", () => {
  const island = Object.create(Island.prototype);
  island.fsm = new IslandStateMachine();
  island.fsm.openOnHover = true;
  island.fsm.mouseEntered();
  island.animateGeometry = () => {};
  State.mode = "expanded";
  State.view = "overview";
  State.tasks = [];
  State.loadIntegrationTasks();
  State.updateTask("integration_claude", "working");
  island.setView("prompt");
  assert.equal(State.view, "prompt");
  assert.equal(island.fsm.openedByHover, false);
  assert.equal(State.tasks.find((task) => task.id === "integration_claude").state, "working");
  island.fsm.cancelTimers();
});

test("the small preview expands explicitly and Home returns to the small size without losing history", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  State.settings = { ...DEFAULT_SETTINGS };
  State.tasks = [];
  State.loadIntegrationTasks();
  State.setFocus("integration_claude");
  State.pendingApproval = null;
  State.appendStep("integration_claude", "Edit · notes.md");
  State.mode = "expanded";
  State.view = "overview";
  State.activityExpanded = false;
  const island = Object.create(Island.prototype);
  island.fsm = new IslandStateMachine();
  island.fsm.openOnHover = true;
  island.fsm.mouseEntered();
  island.animateGeometry = () => {};
  State.mode = "expanded";
  assert.equal(island.targetSize().h, 168);
  island.expandActivity();
  assert.equal(State.activityExpanded, true);
  assert.equal(island.fsm.openedByHover, false, "clicking the preview releases the fast hover close");
  island.fsm.mouseLeft();
  mock.timers.tick(600);
  assert.equal(island.fsm.state, "home", "the editor survives movement to its edge controls");
  assert.equal(island.targetSize().h, 316);
  island.showFileDiff = () => {};
  island.setView("prompt");
  assert.equal(State.view, "prompt");
  island.setView("overview");
  assert.equal(State.activityExpanded, false);
  assert.equal(island.targetSize().h, 168);
  assert.deepEqual(State.focusTask.history, ["Edit · notes.md"]);
  island.fsm.cancelTimers();
  mock.timers.reset();
});
