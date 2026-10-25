import { test } from "node:test";
import assert from "node:assert/strict";
import { fileDiffs, fileInput, isFileEdit } from "../src/core/file-activity.ts";

test("file edits are independent of agent, namespace and file extension", () => {
  for (const tool of ["Edit", "functions.edit_file", "StrReplace", "replace", "patch", "str_replace_editor"]) {
    const [diff] = fileDiffs(tool, { path: "notes/diario.md", old_string: "ayer", new_string: "hoy" });
    assert.equal(diff.path, "notes/diario.md", tool);
    assert.equal(diff.added, 1);
    assert.equal(diff.removed, 1);
    assert.equal(diff.hunks[0].lines.find((l) => l.kind === "added").text, "hoy");
  }
  const [amp] = fileDiffs("edit_file", { path: "config.json", old_str: "false", new_str: "true" });
  assert.equal(amp.removed, 1);
  const [antigravity] = fileDiffs("multi_replace_file_content", {
    TargetFile: "informe.txt", ReplacementChunks: [{ TargetContent: "viejo", ReplacementContent: "nuevo" }],
  });
  assert.equal(antigravity.path, "informe.txt");
  assert.equal(antigravity.added, 1);
});

test("writes use file content aliases, while reading through an editor is not an edit", () => {
  for (const tool of ["Write", "write_file", "create_file", "write_to_file"]) {
    const [diff] = fileDiffs(tool, { TargetFile: "LICENSE", CodeContent: "texto" });
    assert.equal(diff.path, "LICENSE");
    assert.equal(diff.added, 1);
  }
  assert.equal(isFileEdit("str_replace_editor", { command: "view" }), false);
  assert.deepEqual(fileDiffs("str_replace_editor", { command: "view", path: "x", old_str: "a", new_str: "b" }), []);
  assert.deepEqual(fileDiffs("Bash", { command: "echo hi" }), []);
});

test("raw, encoded and object patches retain every file's own changed lines", () => {
  const patch = "*** Begin Patch\n*** Update File: README.md\n@@\n old context\n-before\n+after\n*** Add File: config.json\n+{}\n*** End Patch";
  for (const raw of [patch, JSON.stringify({ patch }), { patch }]) {
    const diffs = fileDiffs("functions.apply_patch", fileInput(raw));
    assert.deepEqual(diffs.map((d) => [d.path, d.added, d.removed]), [["README.md", 1, 1], ["config.json", 1, 0]]);
    assert.equal(diffs[1].isNewFile, true);
    assert.equal(diffs[0].hunks[0].lines.find((l) => l.kind === "added").text, "after");
  }
  assert.deepEqual(fileDiffs("apply_patch", { patch: patch.replace("*** End Patch", "") }), []);
  assert.deepEqual(fileDiffs("apply_patch", { patch: "x".repeat(300_000) }), []);
});
