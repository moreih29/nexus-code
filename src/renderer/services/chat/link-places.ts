import { type FileLink, relativeLinkPath, resolveFileLink } from "./links";

export const MAX_LINK_PLACES = 8;

const FILE_KEYS = ["file_path", "path", "notebook_path"] as const;

const CD = /(?:^|[;&|(\n])\s*cd\s+("[^"]*"|'[^']*'|[^\s;&|()]+)/g;

export interface LinkPlaceIndex {
  cwd: string;
  files: readonly string[];
  folders: readonly string[];
}

interface CallInput {
  input: unknown;
}

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

function scriptsOf(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.filter((word): word is string => typeof word === "string");
  return [];
}

function foldersOf(command: string, from: string, home: string | undefined): string[] {
  const folders: string[] = [];
  let at = from;
  for (const match of command.matchAll(CD)) {
    const raw = match[1] ?? "";
    const target = raw.startsWith('"') || raw.startsWith("'") ? raw.slice(1, -1) : raw;
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
