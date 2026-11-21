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
// An `@` opens the list unless the character before it could end the front
// of an email address (`name@host`); a space, a letter of another script,
// punctuation, or the start of the text all open it.
const FILE_RE = /(^|[^A-Za-z0-9._%+-])@("[^"\n]*|[^\s@"]*)$/;

/**
 * The token the caret is in that the composer completes, if any.
 *
 * A file token opens while the user edits it. A bare `@` can also open at
 * the end of a word, where it has no query yet.
 */
export function completionAt(
  text: string,
  caret: number,
  typedAt: number | null = null,
): Completion | null {
  const before = text.slice(0, caret);
  const inWord = caret < text.length && !/\s/.test(text[caret]);
  const command = COMMAND_RE.exec(before);
  if (command) {
    return inWord ? null : { kind: "command", start: 0, end: caret, query: command[1] };
  }
  const file = fileTokenAt(before);
  if (!file || (file.start !== typedAt && (inWord || file.query !== ""))) return null;
  return { kind: "file", ...file, end: caret };
}

function fileTokenAt(before: string): Pick<Completion, "start" | "query"> | null {
  const match = FILE_RE.exec(before);
  if (!match) return null;
  const token = match[2];
  return { start: before.length - token.length - 1, query: token.replace(/^"/, "") };
}

/** An `@` token the user is editing and where the edit left the caret. */
export interface TypedToken {
  start: number;
  caret: number;
}

/**
 * Follows the mention the user is editing. Start when the user types `@` or
 * edits a query after one already there. Keep it while the edit stays between
 * that `@` and the caret, including changes made by an IME or a paste.
 */
export function followTyped(
  prev: string,
  next: string,
  caret: number,
  typed: TypedToken | null,
): TypedToken | null {
  if (next.length === prev.length + 1 && next.slice(0, caret - 1) + next.slice(caret) === prev) {
    if (next[caret - 1] === "@") return { start: caret - 1, caret };
  }
  if (!typed) {
    const file = fileTokenAt(next.slice(0, caret));
    if (!file || next === prev || !prev.startsWith(next.slice(0, file.start + 1))) return null;
    return { start: file.start, caret };
  }
  if (caret < typed.start + 1) return null;
  const head = typed.start + 1;
  if (prev.slice(0, head) !== next.slice(0, head)) return null;
  if (prev.slice(typed.caret) !== next.slice(caret)) return null;
  return { start: typed.start, caret };
}

/**
 * The session's commands that match what is typed: names (and aliases)
 * that start with it first, then those that contain it. The CLI's own
 * hidden ones (`__name`) are left out. The list is not cut: the menu
 * scrolls, and the commands the CLI lists after its many skills would
 * otherwise fall off it. Built-in commands (the CLI's and the app's) come
 * before skills within each of the two groups; each keeps the order it came in.
 */
export function matchCommands(commands: CommandInfo[], query: string): CommandInfo[] {
  const q = query.toLowerCase();
  const visible = commands.filter((c) => !c.name.startsWith("__"));
  const builtinFirst = (list: CommandInfo[]) => [
    ...list.filter((c) => c.builtin),
    ...list.filter((c) => !c.builtin),
  ];
  if (!q) return builtinFirst(visible);
  const names = (c: CommandInfo) => [c.name, ...(c.aliases ?? [])].map((n) => n.toLowerCase());
  const starts = visible.filter((c) => names(c).some((n) => n.startsWith(q)));
  const contains = visible.filter(
    (c) => !starts.includes(c) && names(c).some((n) => n.includes(q)),
  );
  return [...builtinFirst(starts), ...builtinFirst(contains)];
}

/** A file as the CLI reads a mention of it: quoted when it has a space. */
export function fileMention(path: string): string {
  return /\s/.test(path) ? `@"${path}"` : `@${path}`;
}

/**
 * The text with the token replaced by what was picked, and where the caret
 * goes. A folder is left open (`open` is its token), so its files can be
 * picked next.
 */
export function applyCompletion(
  text: string,
  completion: Completion,
  picked: { kind: "command"; name: string } | { kind: "file"; path: string },
): { text: string; caret: number; open: TypedToken | null } {
  let insert: string;
  if (picked.kind === "command") insert = `/${picked.name} `;
  else if (isFolder(picked.path) && !/\s/.test(picked.path)) insert = `@${picked.path}`;
  else insert = `${fileMention(picked.path)} `;
  // The CLI reads a mention after a space: one goes in front of an `@`
  // that follows other text, and one behind it (the one there, if any, is
  // kept as that one).
  const lead =
    picked.kind === "file" && completion.start > 0 && !/\s/.test(text[completion.start - 1])
      ? " "
      : "";
  const after = text.slice(completion.end);
  const rest = insert.endsWith(" ") ? after.replace(/^ /, "") : after;
  return {
    text: text.slice(0, completion.start) + lead + insert + rest,
    caret: completion.start + lead.length + insert.length,
    // A folder's token goes on, to be completed further.
    open: insert.endsWith(" ")
      ? null
      : {
          start: completion.start + lead.length,
          caret: completion.start + lead.length + insert.length,
        },
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
