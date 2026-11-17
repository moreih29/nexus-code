// Where a file link an agent wrote may point. An agent writes a link from
// the folder its shell is in, and that is the chat's own folder only until
// it changes directory: one that went `cd tracks/project` writes
// `outputs/a.png` for `tracks/project/outputs/a.png`. A relative link is
// looked for from the chat's folder first, then as a file the
// conversation's tools took by that path, then from the folders its
// commands went to, the latest first. As the mobile app looks for them.
// Pure, for the chat and its tests.

import { type FileLink, relativeLinkPath, resolveFileLink } from "./links";

/** Most places one link is looked for in. */
export const MAX_LINK_PLACES = 8;

/** A tool input's keys that name a file. */
const FILE_KEYS = ["file_path", "path", "notebook_path"] as const;

/** `cd DIR` where a command starts: at its start, or after `;`, `&&`, `||`, `|`, `(` or a line. */
const CD = /(?:^|[;&|(\n])\s*cd\s+("[^"]*"|'[^']*'|[^\s;&|()]+)/g;

/** What a conversation shows of where its agent was, which its links may be written from. */
export interface LinkPlaceIndex {
  /** The chat's folder. */
  cwd: string;
  /** The absolute files its tools named, the latest first, each once. */
  files: readonly string[];
  /** The folders its commands went to, the latest first, each once. */
  folders: readonly string[];
}

/** A conversation's tool call, as far as where it went: its input. */
interface CallInput {
  input: unknown;
}

/**
 * Where the agent of a chat in `cwd` went, as its tool calls (in the order
 * they ran) show: the files they named by an absolute path, and the
 * folders its commands went to with `cd` (a Codex command from its own
 * folder). A Windows folder's commands and paths are written another way:
 * none.
 */
export function linkPlaceIndex(
  tools: Readonly<Record<string, CallInput>>,
  cwd: string,
): LinkPlaceIndex {
  const files = new Set<string>();
  const folders = new Set<string>();
  if (cwd.startsWith("/")) {
    const root = normalize(cwd);
    const home = /^(\/Users\/[^/]+|\/home\/[^/]+|\/root)(?=\/|$)/.exec(root)?.[1];
    for (const call of Object.values(tools).reverse()) {
      const input = call.input;
      if (!input || typeof input !== "object") continue;
      const fields = input as Record<string, unknown>;
      for (const key of FILE_KEYS) {
        const value = fields[key];
        if (typeof value === "string" && value.startsWith("/")) files.add(normalize(value));
      }
      // A Codex command runs from the folder it names.
      const from =
        typeof fields.cwd === "string" && fields.cwd.startsWith("/") ? normalize(fields.cwd) : root;
      for (const script of scriptsOf(fields.command)) {
        const went = foldersOf(script, from, home);
        if (from !== root) went.unshift(from);
        for (const folder of went.reverse()) folders.add(folder);
      }
    }
  }
  return { cwd, files: [...files], folders: [...folders] };
}

/**
 * The files a link may name, the likeliest first: as resolveFileLink finds
 * it from the chat's folder, then, for a relative path, as a file the
 * tools named that ends in it, then from each folder the commands went
 * to. Each once, at most MAX_LINK_PLACES; none for a link to no file.
 */
export function linkPlaces(target: string, index: LinkPlaceIndex): FileLink[] {
  const first = resolveFileLink(target, index.cwd);
  if (!first) return [];
  const written = relativeLinkPath(target, index.cwd);
  if (written === null) return [first];
  const places = [first];
  const from = (folder: string) => {
    const link = resolveFileLink(target, folder);
    if (link && !places.some((place) => place.path === link.path)) places.push(link);
  };
  const rel = normalize(written);
  // A path that leaves its folder (`../a.png`) ends no file by what it names.
  if (rel && !rel.startsWith("..")) {
    for (const file of index.files) {
      if (places.length >= MAX_LINK_PLACES) return places;
      if (file.endsWith(`/${rel}`)) from(file.slice(0, -rel.length - 1) || "/");
    }
  }
  for (const folder of index.folders) {
    if (places.length >= MAX_LINK_PLACES) break;
    from(folder);
  }
  return places;
}

/**
 * The first of `places` there is a file at, by its path or by its path
 * with the line kept (FileLink.literal), as `there` finds them; the first
 * place when none is, or when `there` could not tell. One place is not
 * looked for.
 */
export async function findLinkPlace(
  places: readonly FileLink[],
  there: (paths: string[]) => Promise<ReadonlySet<string>>,
): Promise<FileLink | null> {
  const [first] = places;
  if (!first || places.length === 1) return first ?? null;
  const paths = places.flatMap(({ path, literal }) => (literal ? [literal, path] : [path]));
  const found = await there(paths).catch(() => null);
  if (!found) return first;
  return (
    places.find(
      ({ path, literal }) => found.has(path) || (literal !== undefined && found.has(literal)),
    ) ?? first
  );
}

/**
 * A shell call's scripts: Claude's Bash gives one string; a Codex command
 * may come as a list of words, its script one of them (`bash -lc SCRIPT`).
 */
function scriptsOf(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.filter((word): word is string => typeof word === "string");
  return [];
}

/** The folders a command goes to with `cd`, in order, each from the one before. */
function foldersOf(command: string, from: string, home: string | undefined): string[] {
  const folders: string[] = [];
  let at = from;
  for (const match of command.matchAll(CD)) {
    const raw = match[1] ?? "";
    const target = raw.startsWith('"') || raw.startsWith("'") ? raw.slice(1, -1) : raw;
    // A variable or `cd -` names a folder only the shell knew.
    if (!target || target.includes("$") || target.startsWith("-")) continue;
    if (target.startsWith("/")) at = normalize(target);
    else if (target === "~" || target.startsWith("~/")) {
      if (!home) continue;
      at = normalize(`${home}/${target.slice(2)}`);
    } else if (target.startsWith("~")) continue;
    else at = normalize(`${at}/${target}`);
    folders.push(at);
  }
  return folders;
}

/**
 * `.` and `..` worked out, `//` made one, no `/` at the end; absolute stays
 * absolute, and a relative path keeps the `..` that leave it.
 */
function normalize(path: string): string {
  const absolute = path.startsWith("/");
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (part === "..") {
      if (parts.length > 0 && parts[parts.length - 1] !== "..") parts.pop();
      else if (!absolute) parts.push(part);
    } else if (part && part !== ".") parts.push(part);
  }
  return `${absolute ? "/" : ""}${parts.join("/")}`;
}
