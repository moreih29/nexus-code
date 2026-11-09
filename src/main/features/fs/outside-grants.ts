// The files outside a workspace's root that its Claude tabs link, which the
// previews may read: the workspace's protocol and its binary reads serve
// an absolute path only when a tab granted it, the file itself or, for an
// HTML file, the folder it is in. Each tab's grant replaces its last; a tab
// that closes revokes its own. Held in memory: a restart starts empty and
// the tabs grant again as they open.

import fs from "node:fs";
import path from "node:path";
import { isDrivePath } from "../../../shared/fs/outside-url";

interface Grant {
  readonly files: ReadonlySet<string>;
  readonly dirs: readonly string[];
}

const grants = new Map<string, Map<string, Grant>>();

/**
 * A clean absolute path on the workspace's host, or null for anything else:
 * a POSIX path, or a Windows drive's (`C:\…`, `C:/…`) written with `/`.
 * Neither is its root, and `..` does not climb out of a drive.
 */
function absolute(p: string): string | null {
  if (p.includes("\0")) return null;
  const drive = isDrivePath(p);
  if (!drive && !p.startsWith("/")) return null;
  const clean = path.posix.normalize(drive ? p.replace(/\\/g, "/") : p).replace(/\/+$/, "");
  if (drive) return /^[A-Za-z]:\//.test(clean) ? clean : null;
  return clean || null;
}

/**
 * A path as grants are compared: a Windows path with `/` and in one case,
 * as its file system tells no case apart; a POSIX path as it is.
 */
function comparable(p: string): string {
  return isDrivePath(p) ? p.replace(/\\/g, "/").toLowerCase() : p;
}

function cleanAll(paths: readonly string[]): string[] {
  return paths
    .map(absolute)
    .filter((p): p is string => p !== null)
    .map(comparable);
}

/** Replaces what `owner` (a Claude tab) granted in a workspace. */
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

/** Whether `target` is under `dir`, both as grants compare them. */
function isUnderDir(target: string, dir: string): boolean {
  return target.startsWith(`${dir}/`);
}

/** Whether a tab granted `absPath`, as named: the file, or one under a granted folder. */
export function isOutsideGranted(workspaceId: string, absPath: string): boolean {
  const target = absolute(absPath);
  if (!target) return false;
  const key = comparable(target);
  for (const grant of grants.get(workspaceId)?.values() ?? []) {
    if (grant.files.has(key)) return true;
    if (grant.dirs.some((dir) => isUnderDir(key, dir))) return true;
  }
  return false;
}

/**
 * The real path to read for a granted file on this machine, or null. A
 * file granted by name is read where its link points, as it was the file
 * linked; a file granted through its folder must really be in that folder,
 * so a link in it does not reach elsewhere.
 */
export async function resolveOutsideGrant(
  workspaceId: string,
  absPath: string,
): Promise<string | null> {
  const target = absolute(absPath);
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
      } catch {
        // The folder is gone.
      }
    }
  }
  return null;
}

/** Forgets every grant; for tests. */
export function clearOutsideGrants(): void {
  grants.clear();
}
