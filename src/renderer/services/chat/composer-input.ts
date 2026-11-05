// What the composer completes as the user types: a command after a `/` at
// the start of the message, a file after an `@`. Pure, for the composer and
// its tests.

import type { CommandInfo } from "./model";

export interface Completion {
  kind: "command" | "file";
  /** Where the token starts: its `/` or `@`. */
  start: number;
  /** Where it ends: the caret. */
  end: number;
  /** What is typed after the `/` or `@`. */
  query: string;
}

const COMMAND_RE = /^\/(\S*)$/;
const FILE_RE = /(^|\s)@("[^"\n]*|[^\s@"]*)$/;

/** The token the caret is in that the composer completes, if any. */
export function completionAt(text: string, caret: number): Completion | null {
  const before = text.slice(0, caret);
  // Only where the token ends: a caret in the middle of a word completes nothing.
  if (caret < text.length && !/\s/.test(text[caret])) return null;
  const command = COMMAND_RE.exec(before);
  if (command) return { kind: "command", start: 0, end: caret, query: command[1] };
  const file = FILE_RE.exec(before);
  if (file) {
    const query = file[2].startsWith('"') ? file[2].slice(1) : file[2];
    return { kind: "file", start: caret - file[2].length - 1, end: caret, query };
  }
  return null;
}

/** Most commands the list shows at once. */
export const MAX_COMMANDS = 50;

/**
 * The session's commands that match what is typed: names (and aliases)
 * that start with it first, then those that contain it. The CLI's own
 * hidden ones (`__name`) are left out.
 */
export function matchCommands(commands: CommandInfo[], query: string): CommandInfo[] {
  const q = query.toLowerCase();
  const visible = commands.filter((c) => !c.name.startsWith("__"));
  if (!q) return visible.slice(0, MAX_COMMANDS);
  const names = (c: CommandInfo) => [c.name, ...(c.aliases ?? [])].map((n) => n.toLowerCase());
  const starts = visible.filter((c) => names(c).some((n) => n.startsWith(q)));
  const contains = visible.filter(
    (c) => !starts.includes(c) && names(c).some((n) => n.includes(q)),
  );
  return [...starts, ...contains].slice(0, MAX_COMMANDS);
}

/** A file as the CLI reads a mention of it: quoted when it has a space. */
export function fileMention(path: string): string {
  return /\s/.test(path) ? `@"${path}"` : `@${path}`;
}

/**
 * The text with the token replaced by what was picked, and where the caret
 * goes. A folder is left open, so its files can be picked next.
 */
export function applyCompletion(
  text: string,
  completion: Completion,
  picked: { kind: "command"; name: string } | { kind: "file"; path: string },
): { text: string; caret: number } {
  let insert: string;
  if (picked.kind === "command") insert = `/${picked.name} `;
  else if (isFolder(picked.path) && !/\s/.test(picked.path)) insert = `@${picked.path}`;
  else insert = `${fileMention(picked.path)} `;
  const after = text.slice(completion.end);
  const rest = insert.endsWith(" ") ? after.replace(/^ /, "") : after;
  return {
    text: text.slice(0, completion.start) + insert + rest,
    caret: completion.start + insert.length,
  };
}

/** The CLI ends a folder's suggestion with a path separator. */
export function isFolder(path: string): boolean {
  return path.endsWith("/") || path.endsWith("\\");
}

const MENTIONS_RE = /^(?:@(?:"[^"\n]+"|[^\s"]+)\s*)+$/;
const MENTION_RE = /@(?:"([^"\n]+)"|([^\s"]+))/g;

/**
 * A sent message's attached files: the mentions the composer put in its
 * last paragraph, apart from the text before them.
 */
export function splitAttachments(text: string): { text: string; files: string[] } {
  const cut = text.lastIndexOf("\n\n");
  const last = cut >= 0 ? text.slice(cut + 2) : text;
  if (!MENTIONS_RE.test(last.trim())) return { text, files: [] };
  const files = [...last.matchAll(MENTION_RE)].map((m) => m[1] ?? m[2]);
  return { text: cut >= 0 ? text.slice(0, cut) : "", files };
}
