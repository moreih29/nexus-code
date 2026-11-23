import type { GitOperationKind, GitStoreError } from "../../state/stores/git/types";

export type GitErrorPlacement = "status" | "panel" | "toast";

const STATUS_OPERATIONS: ReadonlySet<GitOperationKind> = new Set(["refresh", "init"]);

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

export function isAuthGitError(error: GitStoreError): boolean {
  if (error.kind === "auth" || error.kind === "auth-required") return true;
  return /authentication failed|could not read username|could not read password|permission denied|terminal prompts disabled/i.test(
    `${error.message}\n${error.details ?? ""}`,
  );
}

export function gitErrorPlacement(error: GitStoreError): GitErrorPlacement {
  if (error.operation === undefined || STATUS_OPERATIONS.has(error.operation)) return "status";
  if (PANEL_OPERATIONS.has(error.operation)) return "panel";
  if (PANEL_ERROR_KINDS.has(error.kind) || isAuthGitError(error)) return "panel";
  return "toast";
}

export interface GitErrorSummary {
  readonly summary: string;
  readonly details?: string;
}

const GIT_ERROR_PREFIX = /^(?:fatal|error):\s*/i;

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
