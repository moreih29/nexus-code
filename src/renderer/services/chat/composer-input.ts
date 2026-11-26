import type { CommandInfo } from "./model";

export interface Completion {
  kind: "command" | "file";
  start: number;
  end: number;
  query: string;
}

const COMMAND_RE = /^\/(\S*)$/;
const FILE_RE = /(^|[^A-Za-z0-9._%+-])@("[^"\n]*|[^\s@"]*)$/;

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

export interface TypedToken {
  start: number;
  caret: number;
}

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

export function isCommandMessage(
  text: string,
  images: number,
  commands: readonly CommandInfo[] | undefined,
): boolean {
  const typed = /^\/(\S+)/.exec(text.trim())?.[1]?.toLowerCase();
  if (images > 0 || !typed || !commands) return false;
  return commands.some(
    (c) =>
      c.name.toLowerCase() === typed || c.aliases?.some((alias) => alias.toLowerCase() === typed),
  );
}

export function fileMention(path: string): string {
  return /\s/.test(path) ? `@"${path}"` : `@${path}`;
}

export function applyCompletion(
  text: string,
  completion: Completion,
  picked: { kind: "command"; name: string } | { kind: "file"; path: string },
): { text: string; caret: number; open: TypedToken | null } {
  let insert: string;
  if (picked.kind === "command") insert = `/${picked.name} `;
  else if (isFolder(picked.path) && !/\s/.test(picked.path)) insert = `@${picked.path}`;
  else insert = `${fileMention(picked.path)} `;
  const lead =
    picked.kind === "file" && completion.start > 0 && !/\s/.test(text[completion.start - 1])
      ? " "
      : "";
  const after = text.slice(completion.end);
  const rest = insert.endsWith(" ") ? after.replace(/^ /, "") : after;
  return {
    text: text.slice(0, completion.start) + lead + insert + rest,
    caret: completion.start + lead.length + insert.length,
    open: insert.endsWith(" ")
      ? null
      : {
          start: completion.start + lead.length,
          caret: completion.start + lead.length + insert.length,
        },
  };
}

export function isFolder(path: string): boolean {
  return path.endsWith("/") || path.endsWith("\\");
}

const MENTIONS_RE = /^(?:@(?:"[^"\n]+"|[^\s"]+)\s*)+$/;
const MENTION_RE = /@(?:"([^"\n]+)"|([^\s"]+))/g;

export function attachmentTarget(path: string): string {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) return path;
  const start = /^[a-z]:[/\\]/i.test(path) ? 2 : 0;
  return path.slice(0, start) + path.slice(start).replace(/[%#?:]|^\s+|\s+$/g, encodeURIComponent);
}

export function splitAttachments(text: string): { text: string; files: string[] } {
  const cut = text.lastIndexOf("\n\n");
  const last = cut >= 0 ? text.slice(cut + 2) : text;
  if (!MENTIONS_RE.test(last.trim())) return { text, files: [] };
  const files = [...last.matchAll(MENTION_RE)].map((m) => m[1] ?? m[2]);
  return { text: cut >= 0 ? text.slice(0, cut) : "", files };
}
