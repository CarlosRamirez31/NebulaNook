import { test } from "node:test";
import assert from "node:assert/strict";
import { previewLines, codeTokens } from "../src/core/code-preview.ts";
import { fromEdit } from "../src/core/diff.ts";
import { pendingPreview } from "../src/core/file-activity.ts";

test("the editor overlays actual changes on a full file with actual line numbers", () => {
  const diff = fromEdit("const TVA = 0.196", "const TVA = 0.20", "invoice.ts");
  const lines = previewLines({ path: "invoice.ts", content: "import { Item } from './types'\n\nconst TVA = 0.20\n\nexport function total() {}", startLine: 10 }, diff);
  assert.deepEqual(lines.filter((line) => line.kind !== "context").map((line) => [line.number, line.kind, line.text]), [
    [12, "removed", "const TVA = 0.196"], [12, "added", "const TVA = 0.20"],
  ]);
  assert.equal(lines.at(-1).number, 14);
  assert.match(lines[0].text, /import/);
});

test("snippets and ambiguous matches never invent absolute source line numbers", () => {
  const diff = fromEdit("old", "new", "notes.md");
  assert.ok(previewLines(undefined, diff).every((line) => line.number === null));
  const lines = previewLines({ path: "notes.md", content: "new\nnew" }, diff);
  assert.ok(lines.some((line) => line.kind === "removed" && line.text === "old" && line.number === null));
  const pending = pendingPreview("Edit", { file_path: "notes.md", old_string: "old", new_string: "new" });
  assert.equal(pending.content, "old");
  assert.equal(pending.startLine, 0);
  assert.equal(previewLines(pending, null)[0].number, null);
});

test("pure deletions remain visible even when the tool omitted surrounding context", () => {
  const diff = fromEdit("gone", "", "notes.txt");
  assert.ok(previewLines({ path: "notes.txt", content: "other line" }, diff).some((line) => line.text === "gone" && line.kind === "removed"));
});

test("syntax highlighting preserves literal content and leaves ordinary text unchanged", () => {
  const text = "const TVA = 0.20 // 2026";
  const tokens = codeTokens(text, "invoice.ts");
  assert.equal(tokens.map((token) => token.text).join(""), text);
  assert.ok(tokens.some((token) => token.kind === "keyword" && token.text === "const"));
  assert.ok(tokens.some((token) => token.kind === "number" && token.text === "0.20"));
  assert.ok(tokens.some((token) => token.kind === "comment"));
  assert.deepEqual(codeTokens("<script>alert(1)</script>", "notes.txt"), [{ text: "<script>alert(1)</script>", kind: "plain" }]);
});
