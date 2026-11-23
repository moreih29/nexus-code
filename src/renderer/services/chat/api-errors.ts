import { num, type Rec, rec, str } from "./model";

export type RetryReason = "rate_limit" | "overloaded" | "server" | "connection" | "auth" | "other";

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

export type TurnFailureKind = "usage_limit" | "transient" | "auth" | "request" | "other";

export interface TurnFailure {
  kind: TurnFailureKind;
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

export function codexErrorStatus(info: unknown): number | undefined {
  const variants = rec(info);
  if (!variants) return undefined;
  for (const value of Object.values(variants)) {
    const status = num(rec(value)?.httpStatusCode);
    if (status !== undefined) return status;
  }
  return undefined;
}

export function codexErrorName(info: unknown): string | undefined {
  if (typeof info === "string") return info;
  const variants = rec(info);
  return variants ? Object.keys(variants)[0] : undefined;
}

const CODEX_REQUEST_ERRORS: ReadonlySet<string> = new Set([
  "badRequest",
  "modelNotFound",
  "contextWindowExceeded",
  "sessionBudgetExceeded",
  "cyberPolicy",
  "misalignmentPolicyViolation",
]);

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
    return status !== undefined && status >= 400 && status < 500 && status !== 408 && status !== 429
      ? { kind: "request", ...at }
      : { kind: "transient", ...at };
  }
  return { kind: "other", ...at };
}

export function codexRetryCount(
  message: string | undefined,
): { attempt: number; max: number } | null {
  const match = message ? /(\d+)\s*\/\s*(\d+)/.exec(message) : null;
  if (!match) return null;
  return { attempt: Number(match[1]), max: Number(match[2]) };
}
