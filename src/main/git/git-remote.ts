/**
 * Git remote domain helpers.
 *
 * GitRepository owns queueing, cancellation, and status refresh. This module
 * owns remote argv construction and stable preflight errors for add/remove.
 */
import { isAllowedGitRemoteUrl } from "../../shared/git-remote-validation";
import { GitError } from "./git-error";
import type { RunGitResult } from "./git-process";

export interface GitRemoteRunner {
  readonly run: (args: readonly string[]) => Promise<RunGitResult>;
}

/**
 * Adds one configured remote after validating the local URL pattern. Duplicate
 * names are left to Git so the stderr classifier can surface `remote-exists`.
 */
export async function addRemote(
  git: GitRemoteRunner,
  name: string,
  url: string,
): Promise<void> {
  await git.run(["remote", "add", normalizeRequiredRemoteName(name), normalizeRemoteUrl(url)]);
}

/**
 * Removes one configured remote and normalizes Git's "No such remote" stderr
 * into the task-specific `remote-not-found` kind.
 */
export async function removeRemote(git: GitRemoteRunner, name: string): Promise<void> {
  const remoteName = normalizeRequiredRemoteName(name);
  try {
    await git.run(["remote", "remove", remoteName]);
  } catch (error) {
    throw normalizeRemoteRemoveError(error, remoteName);
  }
}

/**
 * Normalizes a required remote name before using it as a git argv atom.
 */
function normalizeRequiredRemoteName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0 || trimmed.startsWith("-") || /\s/.test(trimmed)) {
    throw new GitError("remote-name-invalid", "Remote name is invalid.");
  }
  return trimmed;
}

/**
 * Normalizes and validates a remote URL without contacting the remote server.
 */
function normalizeRemoteUrl(url: string): string {
  const trimmed = url.trim();
  if (!isAllowedGitRemoteUrl(trimmed)) {
    throw new GitError(
      "remote-url-invalid",
      "Remote URL must start with https://, git@, ssh://, or file://.",
    );
  }
  return trimmed;
}

/**
 * Rewrites both classified and raw "No such remote" failures to a stable
 * remote-management error kind.
 */
function normalizeRemoteRemoveError(error: unknown, remoteName: string): unknown {
  if (!(error instanceof GitError)) return error;
  if (error.kind !== "remote-not-found" && !/no such remote/i.test(error.stderr)) return error;
  return new GitError("remote-not-found", `Remote '${remoteName}' does not exist.`, {
    argv: error.argv,
    stderr: error.stderr,
    stdout: error.stdout,
    exitCode: error.exitCode,
    signal: error.signal,
    cause: error,
  });
}
