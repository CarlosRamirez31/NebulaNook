import { test } from "node:test";
import assert from "node:assert/strict";
import { activityPhase, fileDiffs, fileInput, isFileEdit, shellFilePreview, toolOperations } from "../src/core/file-activity.ts";

test("shell source previews use the actual output and a single unambiguous file", () => {
  assert.deepEqual(shellFilePreview('cat "src/my file.cs"', 'class Todo {}', '/project'),
    { path: '/project/src/my file.cs', content: 'class Todo {}', startLine: 1 });
  assert.equal(shellFilePreview("sed -n '10,20p' src/Todo.cs", 'code').startLine, 10);
  for (const command of ['cat a b', 'cat a; cat b', 'cat $(pwd)', 'cat a | head', 'cat -n a']) {
    assert.equal(shellFilePreview(command, 'code'), undefined, command);
  }
});

test("Cursor searches and Codex shell inspection are read activity", () => {
  for (const tool of ["Read", "Grep", "Glob", "functions.read_file"]) assert.equal(activityPhase(tool), "read");
  for (const cmd of ["rg --files", "cat a.ts; sed -n '1,20p' b.ts", "rg x src | head -20"]) {
    assert.equal(activityPhase("functions.exec_command", { cmd }), "read", cmd);
  }
  for (const cmd of ["cat a.ts; npm test", "cat a > b", "sed -i 's/a/b/' a", "cat $(touch x)"]) {
    assert.equal(activityPhase("exec_command", { cmd }), "bash", cmd);
  }
});

test("Codex literal envelopes expose commands and patches without evaluating code", () => {
  const patch = "*** Begin Patch\n*** Update File: a.ts\n@@\n-old\n+new\n*** End Patch";
  const code = `text(await tools.exec_command({cmd: "cat a.ts", max_output_tokens: 100})); text(await tools.apply_patch(${JSON.stringify(patch)}));`;
  for (const raw of [code, { code }, { command: code }, JSON.stringify({ code })]) {
    const ops = toolOperations("functions.exec", raw);
    assert.deepEqual(ops.map((op) => op.tool), ["exec_command", "apply_patch"]);
    assert.equal(ops[0].input.cmd, "cat a.ts");
    assert.equal(fileDiffs(ops[1].tool, ops[1].input)[0].path, "a.ts");
  }
  for (const code of ['// tools.apply_patch("fake")', 'const x = `tools.apply_patch("fake")`', 'tools.apply_patch(patch)', 'tools.apply_patch(`text ${unknown}`)']) {
    assert.deepEqual(toolOperations("exec", { code }), []);
  }
});

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
