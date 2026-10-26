import { h, svg } from "./dom";
import { ICONS } from "./icons";
import { t } from "../i18n/i18n";
import { fileName } from "../core/diff";

export function isTestRun(command = "", output = ""): boolean {
  return /\b(?:dotnet|cargo)\s+test\b|\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b|\bpytest\b|\bnode\b.*--test|\.(?:test|spec)\.[cm]?[jt]sx?\b/.test(command) ||
    /(?:^|\n)\s*(?:Tests:|Passed!|Failed!|test result:|\d+ passed|ℹ tests\s+\d)/.test(output);
}

/** Short tab labels only; the original command is retained in the tooltip. */
export function commandTabName(command: string): string {
  const tokens = [...command.split(/\r?\n/, 1)[0].matchAll(/"([^"\r\n]*)"|'([^'\r\n]*)'|([^\s;&|]+)|([;&|])/g)];
  const end = tokens.findIndex((token) => token[4]);
  const words = tokens.slice(0, end < 0 ? tokens.length : end).map((word) => word[1] ?? word[2] ?? word[3]);
  while (words.length && (/^[A-Za-z_][A-Za-z_0-9]*=/.test(words[0]) || words[0] === "env")) words.shift();
  const executable = fileName(words[0] || "Bash");
  if (["bash", "sh"].includes(executable) && words.some((word) => /^-[a-z]*c[a-z]*$/.test(word))) return executable;
  if (["python", "python3", "node", "bash", "sh", "pwsh", "powershell"].includes(executable) &&
      words.some((word) => ["-c", "-e", "--eval", "-Command", "-EncodedCommand"].includes(word))) return executable;
  const files: string[] = [];
  for (let index = 1; index < words.length; index++) {
    if (["--import", "--loader", "--require", "-r"].includes(words[index])) { index++; continue; }
    if (!words[index].startsWith("-") && /\.(?:py|sh|bash|ps1|[cm]?js|ts|csproj|slnx?|dll)$/i.test(words[index])) files.push(words[index]);
  }
  if (files.length) return fileName(files[0]);
  if (["npm", "pnpm", "yarn", "bun", "dotnet", "cargo", "git"].includes(executable)) {
    return [executable, ...words.slice(1, words[1] === "run" ? 3 : 2).filter((word) => /^[\w-]+$/.test(word))].join(" ");
  }
  return executable;
}

export function terminalSummary(output: string): string {
  const lines = output.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "").trimEnd().split("\n");
  const results = lines.filter((line) => /(?:\bPASS\b|\bFAIL\b|Passed!|Failed!|Tests:|test result:|^[ℹ#] (?:tests|pass|fail)\b|\d+ (?:passed|failed)\b)/.test(line));
  return (results.length ? results : lines).slice(-2).join("\n");
}

/** Render only reported output. Colours never invent a test result or count. */
export function terminalOutput(output: string, failed = false) {
  const el = h("pre", { class: failed ? "terminal-output failed" : "terminal-output" });
  const plain = output.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\r(?!\n)/g, "\n");
  for (const [index, line] of plain.split("\n").entries()) {
    if (index) el.append("\n");
    const result = /^(\s*)(PASS|FAIL|Passed!|Failed!|✔|✖|✓|✗)(.*)$/.exec(line);
    if (result) {
      const bad = /^(?:FAIL|Failed!|✖|✗)$/.test(result[2]);
      const symbol = /^[✔✖✓✗]$/.test(result[2]);
      const status = symbol
        ? h("span", { class: `terminal-status ${bad ? "is-failed" : "is-passed"}`, role: "img", "aria-label": bad ? t("Failed") : t("Done") }, svg(bad ? "M6 6l12 12M18 6 6 18" : ICONS.check, 11, { stroke: 2.2 }))
        : h("span", { class: bad ? "terminal-fail" : "terminal-pass", text: result[2] });
      el.append(result[1], status, result[3]);
    } else el.append(line);
  }
  return el;
}
