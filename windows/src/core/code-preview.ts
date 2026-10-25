import { parseDiffStep, type FileDiff } from "./diff";
import type { AgentTask, FilePreview } from "./state";

export interface PreviewLine { text: string; number: number | null; kind: "context" | "added" | "removed" }

/** Both sizes show the same historical snapshot, including edits still running. */
export function historyPreview(task: AgentTask, diffs: readonly FileDiff[], selection = (task.history?.length ?? 0) - 1) {
  const history = task.history ?? [];
  let index = selection;
  while (index >= 0 && !task.historyDetails?.[index]?.file && !parseDiffStep(history[index])) index--;
  let file = task.historyDetails?.[index]?.file;
  if (file?.startLine === 0) {
    const pending = file;
    const absolute = task.sessionCwd && !/^(?:[\\/]|[A-Za-z]:[\\/])/.test(pending.path) ? `${task.sessionCwd}/${pending.path}` : pending.path;
    const previous = Object.entries(task.historyDetails ?? {}).filter(([entry, detail]) => Number(entry) < index && detail.file?.startLine !== 0 &&
      (detail.file?.path === pending.path || detail.file?.path === absolute) && detail.file.content.includes(pending.content)).at(-1)?.[1].file;
    if (previous) file = previous;
  }
  const selected = parseDiffStep(history[index] ?? "");
  const diff = selected ? diffs.find((diff) => diff.id === selected.diffId) ?? null : null;
  return { file, diff };
}

/** Overlay confirmed diff hunks on the actual completed file, preserving line numbers. */
export function previewLines(file: FilePreview | undefined, diff: FileDiff | null): PreviewLine[] {
  if (!file) return diff?.hunks.flatMap((hunk) => hunk.lines.map((line) => ({
    text: line.text, number: null, kind: line.kind,
  }))) ?? [];
  const text = file.content.replace(/\r\n/g, "\n").split("\n");
  if (text.at(-1) === "") text.pop();
  const firstLine = file.startLine && file.startLine > 0 ? file.startLine : 1;
  const lines: PreviewLine[] = text.map((line, index) => ({ text: line, number: file.startLine === 0 ? null : index + firstLine, kind: "context" }));
  if (!diff || diff.tooLarge) return lines;
  const overlays: { start: number; count: number; rows: PreviewLine[] }[] = [];
  const unlocated: PreviewLine[] = [];
  for (const hunk of diff.hunks) {
    const current = hunk.lines.filter((line) => line.kind !== "removed");
    const matches: number[] = [];
    for (let start = 0; start <= text.length - current.length; start++) {
      if (current.every((line, offset) => text[start + offset] === line.text)) matches.push(start);
    }
    // An ambiguous snippet must not highlight the wrong occurrence.
    if (!current.length || matches.length !== 1) {
      unlocated.push(...hunk.lines.map((line) => ({ text: line.text, kind: line.kind, number: null })));
      continue;
    }
    const start = matches[0];
    let number = start + firstLine;
    const rows = hunk.lines.map((line): PreviewLine => ({
      text: line.text, kind: line.kind, number: line.kind === "removed" ? number : number++,
    }));
    if (!overlays.some((other) => start < other.start + other.count && other.start < start + current.length)) {
      overlays.push({ start, count: current.length, rows });
    }
  }
  for (const overlay of overlays.sort((a, b) => b.start - a.start)) lines.splice(overlay.start, overlay.count, ...overlay.rows);
  if (unlocated.length) lines.push({ text: "…", number: null, kind: "context" }, ...unlocated);
  return lines;
}

export interface CodeToken { text: string; kind: "plain" | "keyword" | "string" | "number" | "comment" }

/** Display-only tokenization. Every token is rendered as text, never as markup. */
export function codeTokens(text: string, path: string): CodeToken[] {
  if (!/\.(?:[cm]?[jt]sx?|py|rs|go|java|c|cpp|h|hpp|cs|swift|json|ya?ml|toml|sh|bash|css|html?)$/i.test(path)) return [{ text, kind: "plain" }];
  const tokens: CodeToken[] = [];
  const pattern = /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`|\/\/.*$|#.*$|\b\d+(?:\.\d+)?\b|\b(?:import|from|export|const|let|var|function|return|if|else|for|while|class|def|async|await|try|catch|throw|new|type|interface|public|private|fn|pub|use|struct|impl|true|false|null|None|True|False)\b)/g;
  let end = 0;
  for (const match of text.matchAll(pattern)) {
    const index = match.index!;
    if (index > end) tokens.push({ text: text.slice(end, index), kind: "plain" });
    const token = match[0];
    const kind = /^['"`]/.test(token) ? "string" : /^(?:\/\/|#)/.test(token) ? "comment" : /^\d/.test(token) ? "number" : "keyword";
    tokens.push({ text: token, kind });
    end = index + token.length;
  }
  if (end < text.length) tokens.push({ text: text.slice(end), kind: "plain" });
  return tokens;
}
