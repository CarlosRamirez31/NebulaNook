import assert from "node:assert/strict";
import test from "node:test";
// layout.ts is TypeScript; tests load the built helpers via the Vite-free copy path
// used elsewhere, or transpile through the project's test loader.
const layout = await import("../src/core/layout.ts");

const { PANEL_W, UI_SCALE, clientToDesignCss, domToDesignCss } = layout;

test("design CSS hit box stays centred in the 720 panel after UI_SCALE enlargement", () => {
  // Layout viewport already matches the design panel (webview zoom applied).
  const painted = { left: 40, top: 0, width: 640, height: 240 };
  const css = domToDesignCss(painted, PANEL_W);
  assert.deepEqual(css, { x: 40, y: 0, w: 640, h: 240 });
  assert.ok(css.x * UI_SCALE + css.w * UI_SCALE <= PANEL_W * UI_SCALE);
});

test("when the layout viewport is still the enlarged window, DOM and pointer map into design CSS together", () => {
  const viewportW = PANEL_W * UI_SCALE; // 1008: zoom painted but layout not resized
  const painted = { left: 40 * UI_SCALE, top: 0, width: 640 * UI_SCALE, height: 240 * UI_SCALE };
  const css = domToDesignCss(painted, viewportW);
  assert.ok(Math.abs(css.x - 40) < 1e-9);
  assert.ok(Math.abs(css.w - 640) < 1e-9);
  assert.ok(Math.abs(css.h - 240) < 1e-9);

  // Pointer over the chat tab area (right of centre in the painted island).
  const chatClientX = painted.left + painted.width * 0.75;
  const chatClientY = 20 * UI_SCALE;
  const ptr = clientToDesignCss(chatClientX, chatClientY, viewportW);
  assert.ok(ptr.x >= css.x - 14 && ptr.x <= css.x + css.w + 14, "chat stays inside the hit box");
  assert.ok(ptr.y >= css.y - 14 && ptr.y <= css.y + css.h + 14);
});

test("raw unscaled client coords without mapping miss the enlarged hit box", () => {
  const viewportW = PANEL_W * UI_SCALE;
  const painted = { left: 40 * UI_SCALE, top: 0, width: 640 * UI_SCALE, height: 160 * UI_SCALE };
  const css = domToDesignCss(painted, viewportW);
  // Old bug: compare window-logical clientX to design-CSS rect → chat looks outside.
  const chatClientX = painted.left + painted.width * 0.85;
  assert.ok(chatClientX > css.x + css.w, "unmapped client X is past the design rect");
  const mapped = clientToDesignCss(chatClientX, 10, viewportW);
  assert.ok(mapped.x <= css.x + css.w + 14, "mapped client X stays on the island");
});
