/**
 * Pure helpers extracted from `git.ts` so the store body stays focused on
 * state shape and IPC orchestration. Everything here is side-effect free
 * (no IPC, no DOM, no timers) and operates only on values passed in.
 *
 * Anything that touches `useGitStore`, `window`, or the IPC bridge lives in
 * `git.ts` itself or in a dedicated subscription module — not here.
 */

import type { GitActionHint } from "../../../shared/git/types";
import { canUseIpcBridge } from "../../ipc/client";
import { isRecord } from "../../utils/is-record";
import type {
  GitOperationKind,
  GitPushOptions,
  GitSession,
  GitStoreError,
  PendingNonFFRetry,
} from "./git/types";

export { isRecord };

/** Find the first rejected `Promise.allSettled` reason in result order. */
export function firstRejectedReason(
  ...results: PromiseSettledResult<unknown>[]
): unknown | undefined {
  for (const result of results) {
    if (result.status === "rejected") return result.reason;
  }
  return undefined;
}

/** Check whether a thrown value represents an intentional abort. */
export function isAbortError(error: unknown): boolean {
  return isRecord(error) && error.name === "AbortError";
}

/**
 * Narrows a possibly-rehydrated hint payload to a GitActionHint discriminator
 * the panel consumes. The renderer IPC layer copies hint shapes verbatim, so a
 * `kind` string is the only field we need to validate before forwarding.
 */
function isGitActionHint(value: unknown): value is GitActionHint {
  if (!isRecord(value)) return false;
  return typeof value.kind === "string";
}

/**
 * Normalize arbitrary thrown values into the store's user-facing error shape.
 *
 * Reads `kind` and `hint` directly off the error instance — the renderer
 * IPC client (src/renderer/ipc/client.ts) rehydrates these fields onto the
 * thrown Error from the cause envelope set by the main router, so they are
 * present here for typed Git errors. Falls back to `name` / message-based
 * inference for non-GitError throws.
 */
export function gitStoreErrorFromUnknown(
  error: unknown,
  operation?: GitOperationKind,
): GitStoreError {
  if (isRecord(error)) {
    const message = typeof error.message === "string" ? error.message : "Git operation failed";
    const kind =
      typeof error.kind === "string"
        ? error.kind
        : typeof error.name === "string"
          ? error.name
          : "unknown";
    const rawDetails =
      typeof error.details === "string"
        ? error.details
        : typeof error.stderr === "string"
          ? error.stderr
          : undefined;
    // `message` frequently degrades to the trimmed stderr when the agent has
    // no classified summary, leaving `details` (the raw stderr) an exact
    // repeat. Drop the redundant copy so the banner renders it once.
    const details =
      rawDetails && !detailsRepeatMessage(message, rawDetails) ? rawDetails : undefined;
    const hint = isGitActionHint(error.hint) ? error.hint : undefined;

    return { kind, message, details, operation, hint };
  }

  return { kind: "unknown", message: String(error), operation };
}

/**
 * True when `details` carries nothing beyond `message` — an exact match, or
 * `message` already wholly containing it. A details string that is itself the
 * *superset* (a short message plus fuller stderr) is kept: it adds context.
 */
function detailsRepeatMessage(message: string, details: string): boolean {
  const m = message.trim();
  const d = details.trim();
  if (d.length === 0) return true;
  return m === d || (m.length > 0 && m.includes(d));
}

/**
 * Copies only defined push options so pending retries reuse the user's
 * original argv intent without storing transient `undefined` fields.
 */
export function normalizePushOptions(options: GitPushOptions): GitPushOptions {
  return {
    ...(options.force !== undefined ? { force: options.force } : {}),
    ...(options.publish !== undefined ? { publish: options.publish } : {}),
  };
}

/**
 * Finds the current branch label for retry banners; non-FF push failures
 * require a named branch in normal Git flows, so "HEAD" is only a fallback.
 */
function currentBranchName(session: GitSession): string {
  return session.branchInfo?.current ?? session.status?.branch?.current ?? "HEAD";
}

/** Returns true for push guardrail errors that share the pending retry banner. */
export function isPendingNonFFError(error: GitStoreError | null): boolean {
  return error?.kind === "non-fast-forward" || error?.kind === "force-push-rejected";
}

/**
 * Captures enough context to offer a one-click retry after a non-FF push flow.
 */
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
