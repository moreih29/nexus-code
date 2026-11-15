/**
 * folders.list: going through this device's folders from another device,
 * to pick one to add as a workspace (workspace.create). Folders only, and
 * links to folders; never a file's name.
 */
import { execFile } from "node:child_process";
import type { Dirent } from "node:fs";
import { access, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve, win32 } from "node:path";
import { promisify } from "node:util";
import {
  MAX_FOLDERS,
  RpcErrorCode,
  type RpcParams,
  type RpcResult,
} from "../../../../packages/remote-protocol/src";
import { RpcFailure } from "./room";

const run = promisify(execFile);

/** What folders.list reads with: the platform's own, or a test's. */
export interface FolderSystem {
  readonly platform: NodeJS.Platform;
  home(): string;
  /** Windows: the names in `dir` its hidden attribute marks. */
  hiddenIn?(dir: string): Promise<ReadonlySet<string>>;
  /** Windows: the drives' roots there are. */
  drives?(): Promise<string[]>;
}

export const SYSTEM_FOLDERS: FolderSystem = {
  platform: process.platform,
  home: homedir,
  hiddenIn: windowsHidden,
  drives: windowsDrives,
};

/** The folders in `params.path` (the home folder when none), by name, case aside. */
export async function listFolders(
  { path: asked, hidden = false }: RpcParams<"folders.list">,
  system: FolderSystem = SYSTEM_FOLDERS,
): Promise<RpcResult<"folders.list">> {
  const home = system.home();
  if (asked !== undefined && !isAbsolute(asked)) {
    throw new RpcFailure(RpcErrorCode.InvalidParams, "the path is to be absolute");
  }
  const dir = resolve(asked ?? home);
  let read: Dirent[];
  try {
    read = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    throw folderFailure(error, dir);
  }
  const windows = system.platform === "win32";
  const hiddenHere =
    windows && !hidden && system.hiddenIn
      ? await system.hiddenIn(dir).catch(() => new Set<string>())
      : new Set<string>();
  const names: string[] = [];
  for (const entry of read) {
    if (!hidden && (entry.name.startsWith(".") || hiddenHere.has(entry.name))) continue;
    if (
      entry.isDirectory() ||
      (entry.isSymbolicLink() && (await isFolder(join(dir, entry.name))))
    ) {
      names.push(entry.name);
    }
  }
  names.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
  const parent = dirname(dir);
  const roots = windows && system.drives ? await system.drives().catch(() => []) : [];
  return {
    path: dir,
    ...(parent !== dir ? { parent } : {}),
    home,
    ...(roots.length > 0 ? { roots } : {}),
    entries: names.slice(0, MAX_FOLDERS).map((name) => ({ name })),
    ...(names.length > MAX_FOLDERS ? { truncated: true } : {}),
  };
}

/** The folder `asked` names, resolved; NotFound when it is none. */
export async function folderAt(asked: string): Promise<string> {
  if (!isAbsolute(asked)) {
    throw new RpcFailure(RpcErrorCode.InvalidParams, "the path is to be absolute");
  }
  const dir = resolve(asked);
  let isDir: boolean;
  try {
    isDir = (await stat(dir)).isDirectory();
  } catch (error) {
    throw folderFailure(error, dir);
  }
  if (!isDir) throw new RpcFailure(RpcErrorCode.NotFound, `no folder ${dir}`);
  return dir;
}

async function isFolder(target: string): Promise<boolean> {
  return stat(target).then(
    (s) => s.isDirectory(),
    () => false,
  );
}

function folderFailure(error: unknown, dir: string): RpcFailure {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "EACCES" || code === "EPERM") {
    return new RpcFailure(RpcErrorCode.Forbidden, "permission denied");
  }
  if (code === "ENOENT" || code === "ENOTDIR") {
    return new RpcFailure(RpcErrorCode.NotFound, `no folder ${dir}`);
  }
  return new RpcFailure(RpcErrorCode.Unavailable, (error as Error).message ?? String(error));
}

/**
 * The names in `dir` Windows marks hidden: attrib lists each entry with its
 * attribute letters before its path, H among them for a hidden one.
 */
async function windowsHidden(dir: string): Promise<ReadonlySet<string>> {
  const { stdout } = await run("attrib", [join(dir, "*"), "/D"], {
    windowsHide: true,
    timeout: 5_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  return hiddenOf(stdout);
}

/** The hidden names in attrib's listing. */
export function hiddenOf(listing: string): ReadonlySet<string> {
  const hidden = new Set<string>();
  for (const line of listing.split(/\r?\n/)) {
    const at = line.search(/[A-Za-z]:\\|\\\\/);
    if (at < 0) continue;
    if (line.slice(0, at).includes("H")) hidden.add(win32.basename(line.slice(at).trim()));
  }
  return hidden;
}

/** The drives' roots Windows has, C:\ and on. */
async function windowsDrives(): Promise<string[]> {
  const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
  const found = await Promise.all(
    letters.map((letter) =>
      access(`${letter}:\\`).then(
        () => `${letter}:\\`,
        () => null,
      ),
    ),
  );
  return found.filter((root): root is string => root !== null);
}
