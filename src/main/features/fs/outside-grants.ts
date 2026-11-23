import fs from "node:fs";
import path from "node:path";
import { isDrivePath } from "../../../shared/fs/outside-url";

interface Grant {
  readonly files: ReadonlySet<string>;
  readonly dirs: readonly string[];
}

const grants = new Map<string, Map<string, Grant>>();

function absolute(p: string): string | null {
  if (p.includes("\0")) return null;
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
    .map(absolute)
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
  const target = absolute(absPath);
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
      } catch {}
    }
  }
  return null;
}

export function clearOutsideGrants(): void {
  grants.clear();
}
