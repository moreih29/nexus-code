/**
 * Git tag domain helpers.
 *
 * GitRepository owns queueing and status refresh orchestration. This module
 * owns tag argv construction, typed preflight errors, and NUL-safe list
 * parsing so tag management stays separate from branch and remote helpers.
 */
import type { Tag } from "../../shared/types/git";
import { GitError } from "./git-error";
import { runGit, type RunGitResult } from "./git-process";
import type { BuildHelperEnvOptions } from "./helpers-launcher";

export interface GitTagCommandContext {
  readonly bin: string;
  readonly cwd: string;
}

export interface GitTagMutationRunner {
  readonly run: (args: readonly string[]) => Promise<RunGitResult>;
  readonly runWithHelpers: (
    args: readonly string[],
    helpers: BuildHelperEnvOptions,
  ) => Promise<RunGitResult>;
}

export interface CreateTagOptions {
  readonly ref?: string;
  readonly message?: string;
}

const TAG_FIELD_SEPARATOR = "\x1f";
const TAG_RECORD_SEPARATOR = "\x1e";
const TAG_FORMAT = [
  "%(refname:short)",
  "%(objectname)",
  "%(*objectname)",
  "%(objecttype)",
  "%(taggerdate:unix)",
  "%(contents:subject)",
].join("%1f");

/**
 * Lists local tags without taking the repository mutation queue. The command is
 * read-only and uses explicit record separators so subjects cannot disturb
 * field boundaries.
 */
export async function listTags(
  git: GitTagCommandContext,
  signal?: AbortSignal,
): Promise<Tag[]> {
  const { stdout } = await runGit({
    bin: git.bin,
    cwd: git.cwd,
    args: ["for-each-ref", `--format=${TAG_FORMAT}${TAG_RECORD_SEPARATOR}`, "refs/tags"],
    interactive: false,
    signal,
  });
  return parseTagList(stdout);
}

/**
 * Creates a lightweight tag when message is empty, or an annotated tag when a
 * message is provided. The target ref is preflighted so bad refs surface as the
 * task-specific `ref-not-found` kind instead of Git's version-dependent text.
 */
export async function createTag(
  git: GitTagMutationRunner,
  name: string,
  options: CreateTagOptions = {},
): Promise<void> {
  const tagName = normalizeRequiredTagName(name);
  const targetRef = normalizeTagTargetRef(options.ref);
  await assertTagTargetExists(git, targetRef);

  const message = options.message?.trim();
  const args =
    message && message.length > 0
      ? ["tag", "-a", tagName, targetRef, "-m", message]
      : ["tag", tagName, targetRef];
  await git.run(args);
}

/**
 * Deletes one local tag.
 */
export async function deleteTag(git: GitTagMutationRunner, name: string): Promise<void> {
  await git.run(["tag", "-d", normalizeRequiredTagName(name)]);
}

/**
 * Deletes one tag ref from a remote using an askpass-capable push operation.
 */
export async function deleteRemoteTag(
  git: GitTagMutationRunner,
  remote: string,
  name: string,
): Promise<void> {
  const remoteName = normalizeRequiredRemoteName(remote);
  const tagName = normalizeRequiredTagName(name);
  await git.runWithHelpers(["push", remoteName, `:refs/tags/${tagName}`], { askpass: true });
}

/**
 * Parses the for-each-ref tag payload into the shared Tag shape.
 */
export function parseTagList(stdout: string): Tag[] {
  const tags: Tag[] = [];
  for (const rawRecord of stdout.split(TAG_RECORD_SEPARATOR)) {
    const record = rawRecord.replace(/^\r?\n/, "");
    if (record.trim().length === 0) continue;

    const [name, objectSha, dereferencedSha, objectType, taggerDate, subject] =
      record.split(TAG_FIELD_SEPARATOR);
    const normalizedName = name?.trim() ?? "";
    const directSha = objectSha?.trim() ?? "";
    if (!normalizedName || !directSha) continue;

    const isAnnotated = objectType?.trim() === "tag";
    const targetSha = isAnnotated ? dereferencedSha?.trim() || directSha : directSha;
    tags.push({
      name: normalizedName,
      sha: targetSha,
      message: isAnnotated ? normalizeOptionalText(subject) : null,
      type: isAnnotated ? "annotated" : "lightweight",
      taggerDate: isAnnotated ? parseTaggerDate(taggerDate) : null,
    });
  }
  return tags;
}

/**
 * Validates tag names before they become argv atoms.
 */
function normalizeRequiredTagName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0 || trimmed.startsWith("-")) {
    throw new GitError("tag-name-invalid", "Tag name is invalid.");
  }
  return trimmed;
}

/**
 * Normalizes the optional tag target, defaulting to HEAD.
 */
function normalizeTagTargetRef(ref: string | undefined): string {
  const trimmed = ref?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : "HEAD";
}

/**
 * Converts Git's empty fields to null while preserving non-empty subjects.
 */
function normalizeOptionalText(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Converts Git's taggerdate seconds field into nullable epoch milliseconds.
 */
function parseTaggerDate(value: string | undefined): number | null {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) return null;
  const seconds = Number(trimmed);
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return Math.trunc(seconds * 1000);
}

/**
 * Resolves the tag target before creation so bad refs receive a stable kind.
 */
async function assertTagTargetExists(git: GitTagMutationRunner, ref: string): Promise<void> {
  try {
    await git.run(["rev-parse", "--verify", `${ref}^{object}`]);
  } catch (error) {
    if (error instanceof GitError) {
      throw new GitError("ref-not-found", `Reference '${ref}' was not found.`, {
        argv: error.argv,
        stderr: error.stderr,
        stdout: error.stdout,
        exitCode: error.exitCode,
        signal: error.signal,
        cause: error,
      });
    }
    throw error;
  }
}

/**
 * Normalizes remote names before push operations.
 */
function normalizeRequiredRemoteName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0 || trimmed.startsWith("-") || /\s/.test(trimmed)) {
    throw new GitError("remote-name-invalid", "Remote name is invalid.");
  }
  return trimmed;
}
