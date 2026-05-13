/**
 * Git stash domain helpers.
 *
 * The repository class owns queueing; this module keeps stash argv, parsing,
 * and stash-specific error normalization isolated from the broader
 * GitRepository surface.
 */
import type { DiffChunk, DiffComplete, StashEntry } from "../../shared/types/git";
import { streamGitTextChunks } from "./git-diff-stream";
import { GitError } from "./git-error";
import { type GitProcessExecutor, runGit } from "./git-process";

interface GitCommandContext {
  readonly bin: string;
  readonly cwd: string;
  readonly executor?: GitProcessExecutor;
}

const STASH_REF_RE = /^stash@\{(\d+)\}$/;
const STASH_MESSAGE_PATTERNS = [/^On ([^:]+):\s*(.*)$/i, /^WIP on ([^:]+):\s*(.*)$/i];

/**
 * Lists stash entries using NUL-delimited fields so stash subjects containing
 * punctuation do not disturb parsing.
 */
export async function listStashes(
  git: GitCommandContext,
  signal?: AbortSignal,
): Promise<StashEntry[]> {
  const { stdout } = await runGit({
    bin: git.bin,
    cwd: git.cwd,
    args: ["stash", "list", "--format=%gd%x00%H%x00%gs%x00%ct%x00"],
    interactive: false,
    signal,
    executor: git.executor,
  });
  return parseStashList(stdout);
}

/**
 * Applies a stash by index and rewrites generic merge-conflict failures into
 * `stash-conflict`, giving the renderer a stable stash-specific banner kind.
 */
export async function applyStash(
  git: GitCommandContext,
  index: number,
  signal?: AbortSignal,
): Promise<void> {
  try {
    await runGit({
      bin: git.bin,
      cwd: git.cwd,
      args: ["stash", "apply", stashRef(index)],
      interactive: false,
      signal,
      executor: git.executor,
    });
  } catch (error) {
    throw normalizeStashApplyError(error);
  }
}

/**
 * Drops one stash by index.
 */
export async function dropStash(
  git: GitCommandContext,
  index: number,
  signal?: AbortSignal,
): Promise<void> {
  await runGit({
    bin: git.bin,
    cwd: git.cwd,
    args: ["stash", "drop", stashRef(index)],
    interactive: false,
    signal,
    executor: git.executor,
  });
}

/**
 * Pops the top stash entry, preserving Git's "drop only after clean apply"
 * behavior while returning stash-specific conflict errors.
 */
export async function popLatestStash(git: GitCommandContext, signal?: AbortSignal): Promise<void> {
  try {
    await runGit({
      bin: git.bin,
      cwd: git.cwd,
      args: ["stash", "pop"],
      interactive: false,
      signal,
      executor: git.executor,
    });
  } catch (error) {
    throw normalizeStashApplyError(error);
  }
}

/**
 * Streams one stash patch through the shared text chunker.
 */
export async function* showStash(
  git: GitCommandContext,
  index: number,
  signal?: AbortSignal,
): AsyncGenerator<DiffChunk, DiffComplete, unknown> {
  return yield* streamGitTextChunks({
    bin: git.bin,
    cwd: git.cwd,
    args: ["stash", "show", "--patch", "--no-ext-diff", stashRef(index)],
    signal,
    executor: git.executor,
  });
}

/**
 * Stashes only the selected paths. `--include-untracked` is intentionally
 * paired with the explicit pathspec so untracked files inside the selected
 * group can be stashed without swallowing unrelated untracked work.
 */
export async function stashGroup(
  git: GitCommandContext,
  paths: readonly string[],
  message?: string,
  signal?: AbortSignal,
): Promise<void> {
  const uniquePaths = Array.from(new Set(paths.map((p) => p.trim()).filter(Boolean)));
  if (uniquePaths.length === 0) throw new GitError("path-not-in-repo", "No paths selected");

  const args = ["stash", "push", "--include-untracked"];
  const trimmedMessage = message?.trim();
  if (trimmedMessage) args.push("-m", trimmedMessage);
  args.push("--", ...uniquePaths);

  await runGit({
    bin: git.bin,
    cwd: git.cwd,
    args,
    interactive: false,
    signal,
    executor: git.executor,
  });
}

/**
 * Parses the `git stash list --format=%gd%x00%H%x00%gs%x00%ct%x00` payload.
 */
export function parseStashList(stdout: string): StashEntry[] {
  const fields = stdout.split("\x00");
  const entries: StashEntry[] = [];

  for (let offset = 0; offset + 3 < fields.length; offset += 4) {
    const ref = fields[offset]?.trim() ?? "";
    if (!ref) continue;
    const sha = fields[offset + 1]?.trim() ?? "";
    const rawMessage = normalizeRecordText(fields[offset + 2] ?? "");
    const createdAtSeconds = Number((fields[offset + 3] ?? "").trim());
    const index = parseStashIndex(ref);
    if (index === null || !sha || !Number.isFinite(createdAtSeconds) || createdAtSeconds < 0) {
      continue;
    }

    const parsedSubject = parseStashSubject(rawMessage);
    entries.push({
      index,
      sha,
      message: parsedSubject.message,
      branch: parsedSubject.branch,
      createdAt: Math.trunc(createdAtSeconds * 1000),
    });
  }

  return entries;
}

/**
 * Builds the canonical stash ref and validates renderer-provided indexes.
 */
function stashRef(index: number): string {
  if (!Number.isInteger(index) || index < 0) {
    throw new GitError("stash-not-found", `Invalid stash index: ${index}`);
  }
  return `stash@{${index}}`;
}

/**
 * Extracts the numeric part from `stash@{n}`.
 */
function parseStashIndex(ref: string): number | null {
  const match = STASH_REF_RE.exec(ref);
  if (!match) return null;
  return Number(match[1]);
}

/**
 * Removes the newline Git prints between NUL-delimited stash records.
 */
function normalizeRecordText(value: string): string {
  return value.replace(/^\r?\n/, "").trim();
}

/**
 * Splits Git's stash reflog subject into display subject and source branch.
 */
function parseStashSubject(rawMessage: string): { branch: string | null; message: string } {
  for (const pattern of STASH_MESSAGE_PATTERNS) {
    const match = pattern.exec(rawMessage);
    if (!match) continue;
    return {
      branch: match[1]?.trim() || null,
      message: match[2]?.trim() || rawMessage,
    };
  }
  return { branch: null, message: rawMessage };
}

/**
 * Converts generic merge conflict classifications from `git stash apply` into
 * the stash-specific kind accepted by the renderer.
 */
function normalizeStashApplyError(error: unknown): unknown {
  if (
    error instanceof GitError &&
    (error.kind === "conflict" ||
      error.kind === "unresolved-conflicts" ||
      isStashConflictOutput(error.stdout))
  ) {
    return new GitError("stash-conflict", error.message, {
      argv: error.argv,
      stderr: error.stderr,
      stdout: error.stdout,
      exitCode: error.exitCode,
      signal: error.signal,
      cause: error,
      hint: error.hint,
    });
  }
  return error;
}

/**
 * Git reports stash content conflicts on stdout, not stderr, on some versions.
 */
function isStashConflictOutput(stdout: string): boolean {
  return /CONFLICT \([^)]+\):|Merge conflict in|Unmerged paths:/i.test(stdout);
}
