// Atomic file write with stale-write detection.
//
// Pattern: write to a sibling tmp file in the same directory → fsync the
// tmp's fd → rename tmp over the target. POSIX guarantees rename within
// the same filesystem is atomic, so a crash mid-write either leaves the
// previous version intact or completes the swap. fsync ensures bytes are
// flushed before the rename advertises them.
//
// Stale-write guard: caller passes the (mtime, size) it last observed for
// the target. We re-stat and refuse to write if those don't match — the
// file was modified outside our knowledge and a write would silently
// stomp those changes. Caller decides resolution (reload, force, merge).
//
// Symlink fallback: rename-over-symlink replaces the symlink itself, not
// its target. Editors expect "save preserves the symlink and writes
// through it". So when the target is a symlink, we resolve to its target
// and write there directly without atomic rename. This trades atomicity
// for the user's intent — matches VSCode behavior.
//
// First-write (file not yet on disk): caller passes expected.exists=false.
// We refuse if the file appeared meanwhile.

import fs from "node:fs";
import path from "node:path";

export type ExpectedFileState = { exists: false } | { exists: true; mtime: string; size: number };

export type AtomicWriteResult =
  | { kind: "ok"; mtime: string; size: number }
  | { kind: "conflict"; actual: ExpectedFileState };

export interface AtomicWriteOptions {
  expected: ExpectedFileState;
}

const TMP_PREFIX = ".nexus-tmp-";

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 10);
}

function expectedStateFromStat(stat: fs.Stats): ExpectedFileState {
  return { exists: true, mtime: stat.mtime.toISOString(), size: stat.size };
}

async function statOrNull(absPath: string): Promise<fs.Stats | null> {
  try {
    return await fs.promises.lstat(absPath);
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

function expectedMatches(expected: ExpectedFileState, actual: fs.Stats | null): boolean {
  if (!expected.exists) return actual === null;
  if (!actual) return false;
  if (actual.isDirectory()) return false;
  return actual.mtime.toISOString() === expected.mtime && actual.size === expected.size;
}

async function plainWrite(absTarget: string, content: string): Promise<fs.Stats> {
  const fd = await fs.promises.open(absTarget, "w");
  try {
    await fd.writeFile(content, "utf8");
    await fd.sync();
  } finally {
    await fd.close();
  }
  return fs.promises.lstat(absTarget);
}

async function atomicReplace(absTarget: string, content: string): Promise<fs.Stats> {
  const dir = path.dirname(absTarget);
  const base = path.basename(absTarget);
  const tmp = path.join(dir, `${TMP_PREFIX}${base}.${randomSuffix()}`);

  // Write + fsync the tmp file first so bytes hit disk before we expose
  // them to the target name.
  const fd = await fs.promises.open(tmp, "w");
  try {
    await fd.writeFile(content, "utf8");
    await fd.sync();
  } finally {
    await fd.close();
  }

  try {
    await fs.promises.rename(tmp, absTarget);
  } catch (renameError) {
    // Best-effort tmp cleanup; swallow secondary errors so the original
    // rename failure is what reaches the caller.
    await fs.promises.unlink(tmp).catch(() => {});
    throw renameError;
  }

  return fs.promises.lstat(absTarget);
}

export async function atomicWriteFile(
  absTarget: string,
  content: string,
  options: AtomicWriteOptions,
): Promise<AtomicWriteResult> {
  const beforeStat = await statOrNull(absTarget);

  if (!expectedMatches(options.expected, beforeStat)) {
    return {
      kind: "conflict",
      actual: beforeStat ? expectedStateFromStat(beforeStat) : { exists: false },
    };
  }

  if (beforeStat?.isSymbolicLink()) {
    // Resolve the symlink and write through it. The atomic rename trick
    // would swap the symlink for a regular file; users expect their
    // symlink to remain a symlink.
    const resolved = await fs.promises.realpath(absTarget);
    const stat = await plainWrite(resolved, content);
    return { kind: "ok", mtime: stat.mtime.toISOString(), size: stat.size };
  }

  const stat = await atomicReplace(absTarget, content);
  return { kind: "ok", mtime: stat.mtime.toISOString(), size: stat.size };
}
