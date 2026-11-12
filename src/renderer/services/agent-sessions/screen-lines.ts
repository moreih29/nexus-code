/**
 * A terminal screen's lines as the detail panel draws them: what each line
 * of a coding agent's screen is, told by its shape — a tool call or a
 * message ("⏺ Bash(…)"), the result under it ("⎿ …"), a diff's added or
 * removed line, the status line ("✻ Simmering…"), the prompt box and its
 * rules, the hints under it. Pure: from the text the terminal shows.
 */

export type ScreenLineKind =
  | "item"
  | "result"
  | "added"
  | "removed"
  | "status"
  | "prompt"
  | "rule"
  | "hint"
  | "blank"
  | "text";

export interface ScreenLine {
  readonly kind: ScreenLineKind;
  readonly text: string;
}

const RULE = /^\s*[─━═-]{12,}\s*$/;
const ITEM = /^\s*[⏺●◆]\s/;
const RESULT = /^\s*⎿/;
const STATUS = /^\s*[✻✳✶✢✽·*]\s+\S.*(?:…|\.\.\.)/;
const PROMPT = /^\s*(?:│\s*)?[>›]\s?/;
const HINT = /^\s*(?:⏵⏵|⏸|\?\s+for shortcuts|esc to|ctrl\+|shift\+tab)/i;
// A diff line: a line number, then + or - (Claude Code's Update result).
const ADDED = /^\s+\d+\s+\+/;
const REMOVED = /^\s+\d+\s+-/;

export function classifyLine(text: string): ScreenLineKind {
  if (text.trim() === "") return "blank";
  if (RULE.test(text)) return "rule";
  if (ITEM.test(text)) return "item";
  if (RESULT.test(text)) return "result";
  if (ADDED.test(text)) return "added";
  if (REMOVED.test(text)) return "removed";
  if (STATUS.test(text)) return "status";
  if (HINT.test(text)) return "hint";
  if (PROMPT.test(text)) return "prompt";
  return "text";
}

/** The screen's lines, kinded, with runs of blank lines kept to one. */
export function screenLines(text: string): ScreenLine[] {
  const lines: ScreenLine[] = [];
  for (const line of text.split("\n")) {
    const kind = classifyLine(line);
    if (kind === "blank" && (lines.length === 0 || lines[lines.length - 1]?.kind === "blank")) {
      continue;
    }
    lines.push({ kind, text: line.replace(/\s+$/, "") });
  }
  while (lines[lines.length - 1]?.kind === "blank") lines.pop();
  return lines;
}
