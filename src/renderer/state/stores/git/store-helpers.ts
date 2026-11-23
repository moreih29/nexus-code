import { toSlashPath } from "../../../../shared/fs/drive-path";
import type { GitActionHint, RepoInfo } from "../../../../shared/git/types";
import { classifyGitError } from "../../../utils/error-classification";
import { isRecord } from "../../../utils/is-record";
import type {
  GitOperationKind,
  GitPushOptions,
  GitSession,
  GitStoreError,
  PendingNonFFRetry,
} from "./types";

export { isRecord };

export function withSlashTopLevel(info: RepoInfo): RepoInfo {
  return info.kind === "repo" ? { ...info, topLevel: toSlashPath(info.topLevel) } : info;
}

export function firstRejectedReason(
  ...results: PromiseSettledResult<unknown>[]
): unknown | undefined {
  for (const result of results) {
    if (result.status === "rejected") return result.reason;
  }
  return undefined;
}

export function isAbortError(error: unknown): boolean {
  return isRecord(error) && error.name === "AbortError";
}

function isGitActionHint(value: unknown): value is GitActionHint {
  if (!isRecord(value)) return false;
  return typeof value.kind === "string";
}

export function gitStoreErrorFromUnknown(
  error: unknown,
  operation?: GitOperationKind,
): GitStoreError {
  const { kind, message } = classifyGitError(error, "name");
  if (isRecord(error)) {
    const rawDetails =
      typeof error.details === "string"
        ? error.details
        : typeof error.stderr === "string"
          ? error.stderr
          : undefined;
    const details =
      rawDetails && !detailsRepeatMessage(message, rawDetails) ? rawDetails : undefined;
    const hint = isGitActionHint(error.hint) ? error.hint : undefined;

    return { kind, message, details, operation, hint };
  }

  return { kind, message, operation };
}

function detailsRepeatMessage(message: string, details: string): boolean {
  const m = message.trim();
  const d = details.trim();
  if (d.length === 0) return true;
  return m === d || (m.length > 0 && m.includes(d));
}

export function normalizePushOptions(options: GitPushOptions): GitPushOptions {
  return {
    ...(options.force !== undefined ? { force: options.force } : {}),
    ...(options.publish !== undefined ? { publish: options.publish } : {}),
  };
}

function currentBranchName(session: GitSession): string {
  return session.branchInfo?.current ?? session.status?.branch?.current ?? "HEAD";
}

export function isPendingNonFFError(error: GitStoreError | null): boolean {
  return error?.kind === "non-fast-forward" || error?.kind === "force-push-rejected";
}

export function pendingRetryFromPushError(
  session: GitSession,
  error: GitStoreError,
  originalPushOpts: GitPushOptions,
): PendingNonFFRetry | null {
  if (error.kind === "force-push-rejected" && session.pendingNonFFRetry) {
    return session.pendingNonFFRetry;
  }

  if (error.kind !== "non-fast-forward" && error.kind !== "force-push-rejected") {
    return null;
  }

  return {
    branch: currentBranchName(session),
    attemptedAt: Date.now(),
    originalPushOpts,
  };
}
