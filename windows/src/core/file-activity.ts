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
  if (["read", "read_file", "view_file", "grep", "glob", "search", "list_dir", "ls"].includes(name) || (name === "str_replace_editor" && input.command === "view")) return "read";
  // Shell reads are how Codex commonly inspects a project. Mixed commands stay
  // terminal activity; this classification never executes or opens anything.
  const command = input.command ?? input.cmd;
  if (["bash", "shell", "exec_command", "run_command"].includes(name) && typeof command === "string" &&
      command.split(/;|&&|\|\||\n|\|/).every((part) => /^\s*(?:cat|sed\s+-n|head|tail|rg|grep|ls|pwd|wc|find|stat|file|dotfiles-project-context\s+show|git\s+(?:status|diff))\b/.test(part)) &&
      !/[>`]|\$\(/.test(command)) return "read";
  if (["bash", "shell", "terminal", "exec_command", "run_command", "powershell", "exec", "wait", "write_stdin"].includes(name)) return "bash";
  return "other";
}

/** Decode literal calls in Codex's exec envelope, never evaluate JavaScript.
 * Dynamic arguments remain opaque rather than inventing an applied change. */
export function toolOperations(tool: string, raw: unknown): { tool: string; input: Record<string, unknown> }[] {
  const input = fileInput(raw);
  if (toolName(tool) !== "exec") return [];
  const code = input.code ?? input.input ?? input.command ?? (typeof raw === "string" ? raw : undefined);
  if (typeof code !== "string" || code.length > 256 * 1024) return [];
  const operations: { tool: string; input: Record<string, unknown> }[] = [];
  // Tokenize literals and comments as well as tool names so quoted examples
  // cannot be mistaken for calls. Interpolated templates are deliberately opaque.
  const tokens = /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\/\/[^\n]*|\/\*[\s\S]*?\*\/|\btools\.(apply_patch|exec_command|write_stdin)\s*\(/g;
  for (const token of code.matchAll(tokens)) {
    if (!token[1]) continue;
    const tail = code.slice(token.index! + token[0].length);
    if (token[1] === "write_stdin") {
      const process = /^\s*\{\s*(?:session_id|"session_id")\s*:\s*(\d+)\s*[,}]/.exec(tail);
      if (process) operations.push({ tool: "write_stdin", input: { session_id: Number(process[1]) } });
      continue;
    }
    const literal = token[1] === "apply_patch"
      ? /^\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)\s*\)/.exec(tail)
      : /^\s*\{\s*(?:cmd|"cmd"|'cmd')\s*:\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)\s*[,}]/.exec(tail);
    if (!literal) continue;
    const text = literal[1];
    if (text[0] === "`" && text.includes("${")) continue;
    let value: string;
    try {
      if (text[0] === '"') value = JSON.parse(text);
      else value = text.slice(1, -1).replace(/\\(u[\da-fA-F]{4}|x[\da-fA-F]{2}|[\\'"`nrtbfv0]|\r?\n)/g, (_, escape: string) => {
        if (escape[0] === "u" || escape[0] === "x") return String.fromCharCode(parseInt(escape.slice(1), 16));
        return ({ n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", v: "\v", "0": "\0", "\n": "", "\r\n": "" } as Record<string, string>)[escape] ?? escape;
      });
    } catch { continue; }
    operations.push({ tool: token[1], input: token[1] === "apply_patch" ? { patch: value } : { cmd: value } });
    if (operations.length === 32) break;
  }
  return operations;
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

/** A single literal file read can display its actual stdout as source. Never
 * guess a file for pipelines, multiple commands, expansions or directory reads. */
export function shellFilePreview(command: unknown, output: unknown, cwd = ""): FilePreview | undefined {
  if (typeof command !== "string" || typeof output !== "string") return undefined;
  let path: string | undefined;
  let startLine = 1;
  const cat = /^\s*cat\s+(?:--\s+)?(.+?)\s*$/.exec(command);
  const sed = /^\s*sed\s+-n\s+['"]?(\d+)(?:,\d+)?p['"]?\s+(.+?)\s*$/.exec(command);
  const head = /^\s*head\s+(?:-n\s+\d+\s+|-\d+\s+)?(.+?)\s*$/.exec(command);
  if (cat) path = cat[1];
  else if (sed) { path = sed[2]; startLine = Number(sed[1]); }
  else if (head) path = head[1];
  if (!path || !/^(?:"[^"\\$`\r\n]+"|'[^'\r\n]+'|[^\s;&|<>$`"'\\]+)$/.test(path)) return undefined;
  if (path[0] === '"' || path[0] === "'") path = path.slice(1, -1);
  if (path.startsWith("-") || startLine < 1) return undefined;
  if (cwd && !/^(?:[\\/]|[A-Za-z]:[\\/])/.test(path)) path = `${cwd.replace(/[\\/]+$/, "")}/${path}`;
  return { path, content: output.slice(0, 128 * 1024), startLine };
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
    const patch = input.patch ?? input.input ?? input.patchText ?? input.command;
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
