/**
 * folders.list: going through this device's folders from another device,
 * to pick one to add as a workspace (workspace.create). Folders only, and
 * links to folders; never a file's name.
 *
 * A network or device path (\\host\share, \\?\C:\) is turned down before
 * anything reads it: reading \\host\share has Windows connect to that host,
 * and sign in to it as the user. A folder added from another device
 * (workspace.create, a chat's /add-dir) is taken by its real path, and
 * never a drive's root, the home folder or one above it, nor the system's:
 * what the files methods then read would be all of the disk.
 */
import { execFile } from "node:child_process";
import type { Dirent } from "node:fs";
import { access, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, posix, resolve, win32 } from "node:path";
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
  if (asked !== undefined) refuseNetworkPath(asked, system.platform);
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

/**
 * The real folder `asked` names, for another device to add: NotFound when
 * it is none, Forbidden when it is one not to be added from there.
 */
export async function folderToAdd(
  asked: string,
  system: FolderSystem = SYSTEM_FOLDERS,
): Promise<string> {
  refuseNetworkPath(asked, system.platform);
  if (!isAbsolute(asked)) {
    throw new RpcFailure(RpcErrorCode.InvalidParams, "the path is to be absolute");
  }
  let dir: string;
  let isDir: boolean;
  try {
    dir = await realpath(resolve(asked));
    isDir = (await stat(dir)).isDirectory();
  } catch (error) {
    throw folderFailure(error, resolve(asked));
  }
  if (!isDir) throw new RpcFailure(RpcErrorCode.NotFound, `no folder ${dir}`);
  const home = system.home();
  const homes = [home, await realpath(home).catch(() => home)];
  const why = homes.map((h) => refusedFolder(dir, h, system.platform)).find(Boolean);
  if (why) {
    throw new RpcFailure(
      RpcErrorCode.Forbidden,
      `${dir} is ${why}: it is not added from another device`,
    );
  }
  return dir;
}

/** Turns down a network or device path, before anything reads it. */
export function refuseNetworkPath(asked: string, platform: NodeJS.Platform): void {
  // \\host\share, //host/share, \\?\C:\, \\.\pipe: Windows reads them all.
  if (platform === "win32" ? /^[\\/]{2}/.test(asked) : asked.startsWith("\\\\")) {
    throw new RpcFailure(
      RpcErrorCode.InvalidParams,
      "a network or device path is not taken from another device",
    );
  }
}

/** The system's own folders: none is added, nor any under it. */
const POSIX_SYSTEM = [
  "/System",
  "/Library",
  "/Applications",
  "/usr",
  "/bin",
  "/sbin",
  "/etc",
  "/dev",
  "/proc",
  "/sys",
  "/boot",
  "/lib",
  "/lib32",
  "/lib64",
  "/run",
  "/root",
  "/var/root",
  "/var/db",
  "/var/lib",
  "/var/log",
  "/private/etc",
  "/private/var/root",
  "/private/var/db",
  "/private/var/log",
];
/** Folders that hold others' or everything: not added themselves; one in them is. */
const POSIX_HOLDERS = [
  "/tmp",
  "/var",
  "/private",
  "/private/tmp",
  "/private/var",
  "/Volumes",
  "/opt",
  "/mnt",
  "/media",
  "/srv",
  "/home",
  "/Users",
];
/** A Windows drive's system folders, on any drive: none is added, nor any under it. */
const WINDOWS_SYSTEM = [
  "windows",
  "program files",
  "program files (x86)",
  "programdata",
  "$recycle.bin",
  "system volume information",
];

/**
 * Why a real folder is not to be added from another device: a drive's root,
 * the home folder or one that holds it, or the system's; undefined when it
 * may be.
 */
export function refusedFolder(
  dir: string,
  home: string,
  platform: NodeJS.Platform,
): string | undefined {
  const p = platform === "win32" ? win32 : posix;
  // Windows' and macOS's names are the same whatever their case.
  const key = (path: string) => {
    const resolved = p.resolve(path);
    return platform === "linux" ? resolved : resolved.toLowerCase();
  };
  const at = key(dir);
  const under = (folder: string) => {
    const of = key(folder);
    return at === of || at.startsWith(of.endsWith(p.sep) ? of : of + p.sep);
  };
  if (p.dirname(p.resolve(dir)) === p.resolve(dir)) return "a drive's root";
  if (at === key(home)) return "the home folder";
  if (key(home).startsWith(at.endsWith(p.sep) ? at : at + p.sep))
    return "a folder that holds the home folder";
  if (platform === "win32") {
    const { root } = win32.parse(win32.resolve(dir));
    const first = at.slice(root.length).split(win32.sep)[0] ?? "";
    return WINDOWS_SYSTEM.includes(first) ? "a system folder" : undefined;
  }
  if (POSIX_SYSTEM.some(under)) return "a system folder";
  if (POSIX_HOLDERS.some((folder) => at === key(folder)))
    return "a folder that holds others' files";
  return undefined;
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
 * Lists the names in $env:NEXUS_HIDDEN_IN that Windows marks hidden, a line
 * each, in UTF-8. The folder comes in the environment, never in the command.
 */
const HIDDEN_NAMES =
  "[Console]::OutputEncoding = [Text.Encoding]::UTF8; " +
  "Get-ChildItem -LiteralPath $env:NEXUS_HIDDEN_IN -Force -Attributes Hidden -Name -ErrorAction SilentlyContinue";

/**
 * The names in `dir` Windows marks hidden, as Explorer hides them. attrib
 * would not do: it tells a junction by its target's attributes, so the
 * hidden Application Data, Local Settings and the like in the home folder
 * showed; and it writes in the console's code page (CP949 and the like),
 * so no name outside ASCII matched.
 */
async function windowsHidden(dir: string): Promise<ReadonlySet<string>> {
  const root = process.env.SystemRoot ?? process.env.windir ?? "C:\\Windows";
  const powershell = win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const { stdout } = await run(
    powershell,
    ["-NoProfile", "-NonInteractive", "-Command", HIDDEN_NAMES],
    {
      env: { ...process.env, NEXUS_HIDDEN_IN: dir },
      encoding: "utf8",
      windowsHide: true,
      timeout: 10_000,
      maxBuffer: 8 * 1024 * 1024,
    },
  );
  return hiddenOf(stdout);
}

/** The names in Get-ChildItem -Name's listing, a line each. */
export function hiddenOf(listing: string): ReadonlySet<string> {
  return new Set(
    listing
      .replace(/^\uFEFF/, "")
      .split(/\r?\n/)
      .filter((name) => name !== ""),
  );
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
