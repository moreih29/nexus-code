/**
 * Disk-backed detector for in-progress Git workflow operations.
 *
 * The detector reads marker files under a repository's `.git` directory and
 * does not invoke git. Porcelain parsing remains separate because status rows
 * and operation markers have different inputs and failure modes.
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { GitOperationState } from "../../shared/types/git";

interface ReadOperationStateOptions {
  readonly conflictCount?: number;
}

interface RebaseProgress {
  readonly doneCount: number;
  readonly totalCount: number;
}

const NO_PROGRESS: RebaseProgress = { doneCount: 0, totalCount: 0 };

/**
 * Reads `.git` marker files and returns the active operation, or `none`.
 */
export async function readGitOperationState(
  gitDir: string,
  options: ReadOperationStateOptions = {},
): Promise<GitOperationState> {
  const conflictCount = options.conflictCount ?? 0;
  const headRef = await readHeadRef(gitDir);

  const mergeHead = await readTrimmed(path.join(gitDir, "MERGE_HEAD"));
  if (mergeHead !== null) {
    return {
      kind: "merge",
      headRef,
      mergeRef: mergeHead,
      ...optionalSubject(
        "mergeLabel",
        mergeLabelFromMessage(await readFirstMessageLine(path.join(gitDir, "MERGE_MSG"))),
      ),
      conflictCount,
    };
  }

  const rebaseMergeDir = path.join(gitDir, "rebase-merge");
  if (await pathExists(rebaseMergeDir)) {
    const progress = await readRebaseProgress(rebaseMergeDir, "msgnum", "end");
    return {
      kind: "rebase",
      variant: (await pathExists(path.join(rebaseMergeDir, "interactive")))
        ? "interactive"
        : "merge",
      headRef: await readRebaseHeadRef(rebaseMergeDir, headRef),
      ontoRef: await readTrimmed(path.join(rebaseMergeDir, "onto")),
      ...optionalSubject("ontoLabel", await readRebaseOntoLabel(rebaseMergeDir)),
      doneCount: progress.doneCount,
      totalCount: progress.totalCount,
      conflictCount,
      ...optionalSubject(
        "currentCommitSubject",
        await readFirstMessageLine(path.join(rebaseMergeDir, "message")),
      ),
    };
  }

  const rebaseApplyDir = path.join(gitDir, "rebase-apply");
  if (await pathExists(rebaseApplyDir)) {
    const progress = await readRebaseProgress(rebaseApplyDir, "next", "last");
    return {
      kind: "rebase",
      variant: "apply",
      headRef: await readRebaseHeadRef(rebaseApplyDir, headRef),
      ontoRef: await readTrimmed(path.join(rebaseApplyDir, "onto")),
      ...optionalSubject("ontoLabel", await readRebaseOntoLabel(rebaseApplyDir)),
      doneCount: progress.doneCount,
      totalCount: progress.totalCount,
      conflictCount,
      ...optionalSubject(
        "currentCommitSubject",
        (await readFirstMessageLine(path.join(rebaseApplyDir, "message"))) ??
          (await readFirstMessageLine(path.join(rebaseApplyDir, "msg"))),
      ),
    };
  }

  const cherryPickHead = await readTrimmed(path.join(gitDir, "CHERRY_PICK_HEAD"));
  if (cherryPickHead !== null) {
    return {
      kind: "cherry-pick",
      sourceSha: cherryPickHead,
      ...optionalSubject("sourceSubject", await readFirstMessageLine(path.join(gitDir, "MERGE_MSG"))),
      conflictCount,
    };
  }

  const revertHead = await readTrimmed(path.join(gitDir, "REVERT_HEAD"));
  if (revertHead !== null) {
    return {
      kind: "revert",
      sourceSha: revertHead,
      ...optionalSubject("sourceSubject", await readFirstMessageLine(path.join(gitDir, "MERGE_MSG"))),
      conflictCount,
    };
  }

  return { kind: "none" };
}

/**
 * Reads the current HEAD ref as a short branch name when possible.
 */
async function readHeadRef(gitDir: string): Promise<string | null> {
  const head = await readTrimmed(path.join(gitDir, "HEAD"));
  if (head === null) return null;
  if (!head.startsWith("ref: ")) return head;
  return shortRefName(head.slice("ref: ".length));
}

/**
 * Reads the branch Git records for a rebase, falling back to HEAD.
 */
async function readRebaseHeadRef(
  rebaseDir: string,
  fallbackHeadRef: string | null,
): Promise<string | null> {
  const headName = await readTrimmed(path.join(rebaseDir, "head-name"));
  return headName === null ? fallbackHeadRef : shortRefName(headName);
}

/**
 * Reads Git's human-oriented rebase target label when available.
 */
async function readRebaseOntoLabel(rebaseDir: string): Promise<string | null> {
  const raw = await readTrimmed(path.join(rebaseDir, "onto_name"));
  if (raw === null) return null;
  return shortRefName(raw);
}

/**
 * Reads rebase progress counters from the variant-specific file pair.
 */
async function readRebaseProgress(
  rebaseDir: string,
  doneFile: string,
  totalFile: string,
): Promise<RebaseProgress> {
  const doneText = await readTrimmed(path.join(rebaseDir, doneFile));
  const totalText = await readTrimmed(path.join(rebaseDir, totalFile));
  if (doneText === null || totalText === null) return NO_PROGRESS;
  return {
    doneCount: parseNonnegativeInt(doneText),
    totalCount: parseNonnegativeInt(totalText),
  };
}

/**
 * Converts refs/heads/foo into foo while preserving detached SHAs and tags.
 */
function shortRefName(ref: string): string {
  const headsPrefix = "refs/heads/";
  const remotesPrefix = "refs/remotes/";
  if (ref.startsWith(headsPrefix)) return ref.slice(headsPrefix.length);
  if (ref.startsWith(remotesPrefix)) return ref.slice(remotesPrefix.length);
  return ref;
}

/**
 * Extracts a merge target label from Git's generated MERGE_MSG first line.
 */
function mergeLabelFromMessage(message: string | null): string | null {
  if (message === null) return null;
  const quoted = message.match(/'(.*?)'/)?.[1]?.trim();
  if (quoted && quoted.length > 0) return quoted;
  return message.trim().length > 0 ? message.trim() : null;
}

/**
 * Parses Git counter files and treats malformed values as unknown progress.
 */
function parseNonnegativeInt(value: string): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

/**
 * Returns true when a marker file or directory exists.
 */
async function pathExists(absPath: string): Promise<boolean> {
  try {
    await fs.access(absPath);
    return true;
  } catch (error) {
    if (isEnoent(error)) return false;
    throw error;
  }
}

/**
 * Reads a marker file and returns null when the file is absent or empty.
 */
async function readTrimmed(absPath: string): Promise<string | null> {
  try {
    const value = (await fs.readFile(absPath, "utf8")).trim();
    return value.length > 0 ? value : null;
  } catch (error) {
    if (isEnoent(error)) return null;
    throw error;
  }
}

/**
 * Reads the first non-empty, non-comment line from Git's workflow message
 * files so the renderer can name the paused commit without spawning git.
 */
async function readFirstMessageLine(absPath: string): Promise<string | null> {
  const text = await readTrimmed(absPath);
  if (text === null) return null;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    return trimmed;
  }
  return null;
}

/**
 * Adds optional subject fields only when Git wrote a useful message line.
 */
function optionalSubject<K extends "currentCommitSubject" | "mergeLabel" | "ontoLabel" | "sourceSubject">(
  key: K,
  value: string | null,
): Record<K, string> | Record<string, never> {
  return value ? { [key]: value } as Record<K, string> : {};
}

/**
 * Identifies missing-path filesystem errors without depending on Node classes.
 */
function isEnoent(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as { code?: string }).code === "ENOENT"
  );
}
