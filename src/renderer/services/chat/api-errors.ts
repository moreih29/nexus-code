/**
 * What an API error that Claude Code or Codex reports means for a tab: why
 * its program is trying a request again, and, when a turn failed, whether
 * trying again can help. Both programs retry transient errors themselves
 * (Claude Code up to 10 times, Codex up to 5), so the app never retries on
 * its own: it says what happens, and offers to go on once a turn failed.
 * Pure.
 */

import { num, type Rec, rec, str } from "./model";

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

/**
 * How a failed turn can go on:
 * - usage_limit: the plan's usage limit; it goes on once the limit resets.
 * - transient: a rate limit, an overloaded or failing server, a dropped
 *   connection that outlasted the program's own retries; trying again may help.
 * - auth: the sign-in or API key was refused; signing in again or fixing the key helps.
 * - request: the API refused the request itself (400); the same request fails again.
 * - other: anything else (a tool, a hook, a context too long).
 */
export type TurnFailureKind = "usage_limit" | "transient" | "auth" | "request" | "other";

export interface TurnFailure {
  kind: TurnFailureKind;
  /** The HTTP status the API answered with, when it answered. */
  status?: number;
}

function failureOfStatus(status: number | undefined, kind: string | undefined): TurnFailure {
  const at = status === undefined ? {} : { status };
  if (status === 401 || status === 403 || kind === "authentication_failed") {
    return { kind: "auth", ...at };
  }
  if (
    status === 408 ||
    status === 409 ||
    status === 429 ||
    (status !== undefined && status >= 500) ||
    kind === "rate_limit" ||
    kind === "overloaded" ||
    kind === "server_error" ||
    kind === "connection_failed"
  ) {
    return { kind: "transient", ...at };
  }
  if (status === 400 || status === 404 || status === 413 || status === 422) {
    return { kind: "request", ...at };
  }
  return { kind: "other", ...at };
}

/**
 * Why a Claude turn failed, from its result line (or the API error message
 * before it): an API error has `terminal_reason` api_error and the status;
 * the plan's limit is `api_error` usage_limit_reached. None for a turn that
 * did not fail on the API.
 */
export function claudeTurnFailure(message: Rec): TurnFailure | undefined {
  const status = num(message.api_error_status) ?? num(message.apiErrorStatus);
  const apiError = str(message.api_error) ?? str(message.apiError);
  if (apiError === "usage_limit_reached") {
    return { kind: "usage_limit", ...(status === undefined ? {} : { status }) };
  }
  if (status === undefined && message.terminal_reason !== "api_error" && !apiError) {
    return undefined;
  }
  return failureOfStatus(status, apiError ?? str(message.error));
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

/** The name of a Codex error's codexErrorInfo: a string, or an object's one key. */
export function codexErrorName(info: unknown): string | undefined {
  if (typeof info === "string") return info;
  const variants = rec(info);
  return variants ? Object.keys(variants)[0] : undefined;
}

/** Codex errors trying again cannot mend, by their codexErrorInfo name. */
const CODEX_REQUEST_ERRORS: ReadonlySet<string> = new Set([
  "badRequest",
  "modelNotFound",
  "contextWindowExceeded",
  "sessionBudgetExceeded",
  "cyberPolicy",
  "misalignmentPolicyViolation",
]);

/** Codex errors of a server or connection that trying again later may mend. */
const CODEX_TRANSIENT_ERRORS: ReadonlySet<string> = new Set([
  "rateLimitExceeded",
  "internalServerError",
  "serverOverloaded",
  "flexUnavailable",
  "policyCapacityUnavailable",
  "httpConnectionFailed",
  "responseStreamConnectionFailed",
  "responseStreamDisconnected",
  "responseTooManyFailedAttempts",
]);

/** Why a Codex turn failed, from its error's codexErrorInfo. */
export function codexTurnFailure(error: unknown): TurnFailure | undefined {
  const info = rec(error)?.codexErrorInfo;
  const name = codexErrorName(info);
  if (!name) return undefined;
  const status = codexErrorStatus(info);
  const at = status === undefined ? {} : { status };
  if (name === "usageLimitExceeded") return { kind: "usage_limit", ...at };
  if (name === "unauthorized" || status === 401 || status === 403) return { kind: "auth", ...at };
  if (CODEX_REQUEST_ERRORS.has(name)) return { kind: "request", ...at };
  if (CODEX_TRANSIENT_ERRORS.has(name)) {
    // A connection that failed on a 400 is the request's fault, not the server's.
    return status !== undefined && status >= 400 && status < 500 && status !== 408 && status !== 429
      ? { kind: "request", ...at }
      : { kind: "transient", ...at };
  }
  return { kind: "other", ...at };
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
