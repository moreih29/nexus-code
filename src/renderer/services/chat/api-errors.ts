/**
 * What an API error that Claude Code or Codex reports means for a tab: why
 * its program is trying a request again. Both programs retry transient
 * errors themselves (Claude Code up to 10 times, Codex up to 5), so the app
 * never retries on its own: it says what happens. Pure.
 */

import { num, rec } from "./model";

/** Why a request is being tried again, in the words the status line uses. */
export type RetryReason = "rate_limit" | "overloaded" | "server" | "connection" | "auth" | "other";

/**
 * The reason for a retry from the HTTP status and Claude Code's error kind
 * (rate_limit, overloaded, server_error, authentication_failed, unknown).
 * No status is a request that got no answer: a connection dropped or timed out.
 */
export function retryReasonOf(status: number | null | undefined, kind?: string): RetryReason {
  if (status === 429 || kind === "rate_limit") return "rate_limit";
  if (status === 529 || kind === "overloaded") return "overloaded";
  if (status === 401 || status === 403 || kind === "authentication_failed") return "auth";
  if ((status !== undefined && status !== null && status >= 500) || kind === "server_error") {
    return "server";
  }
  if (status === undefined || status === null) return "connection";
  return "other";
}

/** The HTTP status in a Codex error's codexErrorInfo, as `{ variant: { httpStatusCode } }`. */
export function codexErrorStatus(info: unknown): number | undefined {
  const variants = rec(info);
  if (!variants) return undefined;
  for (const value of Object.values(variants)) {
    const status = num(rec(value)?.httpStatusCode);
    if (status !== undefined) return status;
  }
  return undefined;
}

/**
 * Codex's "Reconnecting... 2/5": the try it is on, of how many. Codex
 * counts each phase of its retries anew, so its own numbers are told.
 */
export function codexRetryCount(
  message: string | undefined,
): { attempt: number; max: number } | null {
  const match = message ? /(\d+)\s*\/\s*(\d+)/.exec(message) : null;
  if (!match) return null;
  return { attempt: Number(match[1]), max: Number(match[2]) };
}
