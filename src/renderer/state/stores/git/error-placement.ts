/**
 * Where a git failure is shown, and the short line that leads it.
 *
 *   - "status": the panel could not load or refresh the repository. Shown in
 *     the Source Control panel only — it describes what the panel displays,
 *     and a watcher-driven refresh can fail again and again.
 *   - "panel": a failure whose recovery is driven from the panel (pull or
 *     force after a rejected push, resolving conflicts, continuing or
 *     aborting a merge, signing in from a terminal). Shown in the panel;
 *     when the panel is not on screen, a toast points the user to it.
 *   - "toast": any other failed action. It has nothing to act on in the
 *     panel, so it goes to a toast with the git output under Details.
 */
import type { GitOperationKind, GitStoreError } from "./types";

export type GitErrorPlacement = "status" | "panel" | "toast";

const STATUS_OPERATIONS: ReadonlySet<GitOperationKind> = new Set(["refresh", "init"]);

/** Steps of an operation in progress, whose banner offers Retry and Abort. */
const PANEL_OPERATIONS: ReadonlySet<GitOperationKind> = new Set([
  "continueOp",
  "abortOp",
  "markResolved",
]);

const PANEL_ERROR_KINDS: ReadonlySet<string> = new Set([
  "non-fast-forward",
  "force-push-rejected",
  "protected-branch",
  "pre-receive-hook-rejected",
  "conflict",
  "unresolved-conflicts",
  "stash-conflict",
]);

/**
 * Branches on stable GitError.kind when available, with message fallback for
 * Electron IPC error serialization that can strip custom Error properties.
 */
export function isAuthGitError(error: GitStoreError): boolean {
  if (error.kind === "auth" || error.kind === "auth-required") return true;
  return /authentication failed|could not read username|could not read password|permission denied|terminal prompts disabled/i.test(
    `${error.message}\n${error.details ?? ""}`,
  );
}

export function gitErrorPlacement(error: GitStoreError): GitErrorPlacement {
  // An error without an operation comes from loading the panel's session.
  if (error.operation === undefined || STATUS_OPERATIONS.has(error.operation)) return "status";
  if (PANEL_OPERATIONS.has(error.operation)) return "panel";
  if (PANEL_ERROR_KINDS.has(error.kind) || isAuthGitError(error)) return "panel";
  return "toast";
}

export interface GitErrorSummary {
  /** One line to lead with. */
  readonly summary: string;
  /** Everything git said, when there is more than the summary. */
  readonly details?: string;
}

const GIT_ERROR_PREFIX = /^(?:fatal|error):\s*/i;

/**
 * Shortens a failure to one line. A classified failure already carries a
 * one-line message. An unclassified one carries git's raw output, where the
 * first "fatal:" or "error:" line names the problem and the rest (progress,
 * hints) moves to the details.
 */
export function summarizeGitError(error: GitStoreError): GitErrorSummary {
  const message = error.message.trim();
  const lines = message
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length <= 1) return { summary: message, details: error.details };

  const lead = lines.find((line) => GIT_ERROR_PREFIX.test(line)) ?? lines[0] ?? message;
  const stripped = lead.replace(GIT_ERROR_PREFIX, "");
  const summary = stripped.charAt(0).toUpperCase() + stripped.slice(1);
  return { summary, details: error.details ? `${message}\n\n${error.details}` : message };
}
