// Tool events describe file activity independently of the agent and extension.
import { buildFileDiff, fromEdit, fromNew, type FileDiff } from "./diff";
import type { FilePreview } from "./state";

const EDIT_TOOLS = new Set([
  "edit", "multiedit", "write", "write_file", "write_to_file", "create_file",
  "file_write", "file_edit", "edit_file", "replace", "replace_file_content",
  "multi_replace_file_content", "str_replace", "strreplace", "search_replace", "str_replace_editor", "apply_patch", "patch",
]);

export function toolName(tool: string): string {
  return tool.split(/[.:/]/).at(-1)!.toLowerCase();
}

export function isFileEdit(tool: string, input?: Record<string, unknown>): boolean {
  if (toolName(tool) === "str_replace_editor" && input?.command === "view") return false;
  return EDIT_TOOLS.has(toolName(tool));
}

export function activityPhase(tool: string, input: Record<string, unknown> = {}): "read" | "edit" | "bash" | "other" {
  if (isFileEdit(tool, input)) return "edit";
  const name = toolName(tool);
  if (["read", "read_file", "view_file"].includes(name) || (name === "str_replace_editor" && input.command === "view")) return "read";
  if (["bash", "shell", "terminal", "exec_command", "run_command", "powershell"].includes(name)) return "bash";
  return "other";
}

export function fileInput(raw: unknown): Record<string, unknown> {
  if (typeof raw === "string") {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch { /* Freeform patch input. */ }
    return { patch: raw };
  }
  return raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
}

export function filePath(input: Record<string, unknown>): string | null {
  for (const key of ["file_path", "filePath", "path", "file", "TargetFile", "AbsolutePath"]) {
    if (typeof input[key] === "string") return input[key] as string;
  }
  return null;
}

/** The known old text can be displayed while an edit runs, without applying it. */
export function pendingPreview(tool: string, input: Record<string, unknown>): FilePreview | undefined {
  if (!isFileEdit(tool, input)) return undefined;
  const diff = fileDiffs(tool, input)[0];
  if (!diff) return undefined;
  const content = diff.hunks.flatMap((hunk) => hunk.lines.filter((line) => line.kind !== "added").map((line) => line.text)).join("\n");
  return content && content.length <= 128 * 1024 ? { path: diff.path, content, startLine: 0 } : undefined;
}

/** Only completed tool events become applied diffs. Never read or execute paths. */
export function fileDiffs(tool: string, input: Record<string, unknown>): FileDiff[] {
  if (!isFileEdit(tool, input)) return [];
  const name = toolName(tool);
  if (name === "apply_patch" || name === "patch") {
    const patch = input.patch ?? input.input ?? input.patchText;
    if (typeof patch === "string") return patchDiffs(patch);
    if (name === "apply_patch") return [];
  }
  const path = filePath(input);
  if (!path) return [];
  const canonical = name === "multiedit" ? "MultiEdit" : name === "write" ? "Write" : "Edit";
  const direct = buildFileDiff(canonical, { ...input, file_path: path });
  if (direct) return [direct];
  const chunks = input.ReplacementChunks ?? input.edits ?? [input];
  if (!Array.isArray(chunks)) return [];
  const hunks: FileDiff["hunks"] = [];
  let added = 0, removed = 0, tooLarge = false;
  for (const chunk of chunks) {
    if (!chunk || typeof chunk !== "object") continue;
    const oldText = chunk.old_string ?? chunk.old_str ?? chunk.oldText ?? chunk.TargetContent ?? chunk.old;
    const newText = chunk.new_string ?? chunk.new_str ?? chunk.newText ?? chunk.ReplacementContent ?? chunk.new;
    if (typeof oldText !== "string" || typeof newText !== "string") continue;
    const diff = fromEdit(oldText, newText, path);
    hunks.push(...diff.hunks);
    added += diff.added;
    removed += diff.removed;
    tooLarge ||= diff.tooLarge;
  }
  if (added || removed) return [{ id: 0, path, added, removed, tooLarge, hunks, isNewFile: false }];
  const content = input.content ?? input.contents ?? input.file_text ?? input.FileContent ?? input.CodeContent;
  if (typeof content === "string" && (["write", "write_file", "write_to_file", "create_file", "file_write"].includes(name) || (name === "str_replace_editor" && input.command === "create"))) {
    return [fromNew(content, path)];
  }
  return [];
}

/** apply_patch's explicit file sections, including multi-file patches. */
function patchDiffs(patch: string): FileDiff[] {
  if (new TextEncoder().encode(patch).length > 256 * 1024) return [];
  const lines = patch.replace(/\r\n/g, "\n").split("\n");
  if (lines[0] !== "*** Begin Patch" || !lines.includes("*** End Patch")) return [];
  const diffs: FileDiff[] = [];
  let diff: FileDiff | null = null;
  let oldLine = 1, newLine = 1;
  for (const line of lines.slice(1)) {
    const header = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(line);
    if (header) {
      diff = { id: 0, path: header[2], added: 0, removed: 0, hunks: [], tooLarge: false, isNewFile: header[1] === "Add" };
      diffs.push(diff);
      oldLine = newLine = 1;
    } else if (diff && line.startsWith("*** Move to: ")) {
      diff.path = line.slice(13);
    } else if (diff && line.startsWith("@@")) {
      diff.hunks.push({ origStart: oldLine, newStart: newLine, lines: [] });
    } else if (diff && /^[ +\-]/.test(line)) {
      if (!diff.hunks.length) diff.hunks.push({ origStart: 1, newStart: 1, lines: [] });
      const kind = line[0] === "+" ? "added" : line[0] === "-" ? "removed" : "context";
      if (kind === "added") diff.added++;
      if (kind === "removed") diff.removed++;
      diff.hunks.at(-1)!.lines.push({ kind, text: line.slice(1), origLine: kind === "added" ? -1 : oldLine++, newLine: kind === "removed" ? -1 : newLine++ });
    } else if (line === "*** End Patch") break;
  }
  return diffs.filter((d) => d.added || d.removed);
}
