import fs from "node:fs";
import path from "node:path";
import {
  isDevicePath,
  isDrivePath,
  isNetworkOrDevicePath,
  windowsPathKind,
} from "../../../shared/fs/outside-url";
import type { AppState } from "../../../shared/types/app-state";

interface Grant {
  readonly files: ReadonlySet<string>;
  readonly dirs: readonly string[];
}

const grants = new Map<string, Map<string, Grant>>();

export const MAX_PENDING_PICKS = 64;
export const MAX_KEPT_PICKS = 256;
const pendingPicks = new Map<string, string>();
const keptPicks = new Map<string, string>();
let savePicks: (files: string[]) => void = () => {};

export function isWindowsNetworkPath(path: string): boolean {
  return process.platform === "win32" && isNetworkOrDevicePath(path);
}

function pickKey(file: string): string | null {
  if (!isWindowsNetworkPath(file) || isDevicePath(file) || file.includes("\0")) return null;
  return path.win32.normalize(file).toLowerCase();
}

function trimOldest(picks: Map<string, string>, max: number): void {
  for (const key of picks.keys()) {
    if (picks.size <= max) return;
    picks.delete(key);
  }
}

export function rememberPickedNetworkFile(file: string): void {
  const key = pickKey(file);
  if (key === null || keptPicks.has(key)) return;
  pendingPicks.delete(key);
  pendingPicks.set(key, file);
  trimOldest(pendingPicks, MAX_PENDING_PICKS);
}

export function pickedNetworkFile(file: string): string | undefined {
  const key = pickKey(file);
  return key === null ? undefined : (keptPicks.get(key) ?? pendingPicks.get(key));
}

export function keepPickedNetworkFilesOpenIn(openFiles: Iterable<string>): void {
  const open = new Set<string>();
  for (const file of openFiles) {
    const key = pickKey(file);
    if (key !== null) open.add(key);
  }
  let changed = false;
  for (const [key, file] of pendingPicks) {
    if (!open.has(key)) continue;
    pendingPicks.delete(key);
    keptPicks.set(key, file);
    changed = true;
  }
  for (const key of [...keptPicks.keys()]) {
    if (open.has(key)) continue;
    keptPicks.delete(key);
    changed = true;
  }
  const size = keptPicks.size;
  trimOldest(keptPicks, MAX_KEPT_PICKS);
  if (changed || keptPicks.size !== size) savePicks([...keptPicks.values()]);
}

export function editorTabFiles(layouts: AppState["layoutByWorkspace"]): string[] {
  return Object.values(layouts ?? {}).flatMap(({ tabs }) =>
    tabs.flatMap((tab) => (tab.type === "editor" ? [tab.props.filePath] : [])),
  );
}

export function restorePickedNetworkFiles(
  saved: readonly string[],
  openFiles: Iterable<string>,
  save: (files: string[]) => void,
): void {
  pendingPicks.clear();
  keptPicks.clear();
  savePicks = () => {};
  for (const file of saved) {
    const key = pickKey(file);
    if (key !== null) keptPicks.set(key, file);
  }
  const before = keptPicks.size;
  keepPickedNetworkFilesOpenIn(openFiles);
  savePicks = save;
  if (keptPicks.size !== before || before !== saved.length) save([...keptPicks.values()]);
}

function shareOf(p: string): string | null {
  if (windowsPathKind(p) !== "unc") return null;
  const share = /^\\\\([^\\]+)\\([^\\]+)(?:\\|$)/.exec(path.win32.normalize(p));
  return share ? `\\\\${share[1]}\\${share[2]}`.toLowerCase() : null;
}

export function fileOnRootShare(file: string, root: string | null): string | undefined {
  if (process.platform !== "win32" || !root) return undefined;
  const share = shareOf(root);
  if (!share || shareOf(file) !== share) return undefined;
  const clean = path.win32.normalize(file);
  return shareOf(clean) === share ? clean : undefined;
}

export function cleanAbsolutePath(p: string): string | null {
  if (p.includes("\0") || isWindowsNetworkPath(p)) return null;
  const drive = isDrivePath(p);
  if (!drive && !p.startsWith("/")) return null;
  const clean = path.posix.normalize(drive ? p.replace(/\\/g, "/") : p).replace(/\/+$/, "");
  if (drive) return /^[A-Za-z]:\//.test(clean) ? clean : null;
  return clean || null;
}

function comparable(p: string): string {
  return isDrivePath(p) ? p.replace(/\\/g, "/").toLowerCase() : p;
}

function cleanAll(paths: readonly string[]): string[] {
  return paths
    .map(cleanAbsolutePath)
    .filter((p): p is string => p !== null)
    .map(comparable);
}

export function setOutsideGrant(
  workspaceId: string,
  owner: string,
  files: readonly string[],
  dirs: readonly string[],
): void {
  const byOwner = grants.get(workspaceId) ?? new Map<string, Grant>();
  const grant: Grant = { files: new Set(cleanAll(files)), dirs: cleanAll(dirs) };
  if (grant.files.size === 0 && grant.dirs.length === 0) byOwner.delete(owner);
  else byOwner.set(owner, grant);
  if (byOwner.size === 0) grants.delete(workspaceId);
  else grants.set(workspaceId, byOwner);
}

function isUnderDir(target: string, dir: string): boolean {
  return target.startsWith(`${dir}/`);
}

export function isOutsideGranted(workspaceId: string, absPath: string): boolean {
  const target = cleanAbsolutePath(absPath);
  if (!target) return false;
  const key = comparable(target);
  for (const grant of grants.get(workspaceId)?.values() ?? []) {
    if (grant.files.has(key)) return true;
    if (grant.dirs.some((dir) => isUnderDir(key, dir))) return true;
  }
  return false;
}

export async function resolveOutsideGrant(
  workspaceId: string,
  absPath: string,
): Promise<string | null> {
  const target = cleanAbsolutePath(absPath);
  if (!target) return null;
  const key = comparable(target);
  let real: string;
  try {
    real = await fs.promises.realpath(target);
  } catch {
    return null;
  }
  for (const grant of grants.get(workspaceId)?.values() ?? []) {
    if (grant.files.has(key)) return real;
    for (const dir of grant.dirs) {
      if (!isUnderDir(key, dir)) continue;
      try {
        if (isUnderDir(comparable(real), comparable(await fs.promises.realpath(dir)))) return real;
      } catch {}
    }
  }
  return null;
}

export function clearOutsideGrants(): void {
  grants.clear();
}
