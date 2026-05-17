/**
 * Discriminated Result envelope for ipc:call — the shared wire contract that
 * lets handlers communicate expected failures as values rather than exceptions.
 *
 * DESIGN CONTRACT
 * ---------------
 * A handler that encounters an *expected* failure (one that a caller can react
 * to, e.g. "not found", "auth failed") returns an IpcResult object instead of
 * throwing.  The ipc:call router detects the envelope via `isIpcResult` and
 * passes it through to the renderer without logging anything — the invariant
 * "a log line means a real bug" is therefore preserved.
 *
 * Handlers that encounter *unexpected* failures (bugs) still throw; the router
 * logs those and rejects the renderer-side promise.
 *
 * BRAND KEY
 * ---------
 * `__nexusIpcResult_a3f8b1d2` is a fixed string literal written into every
 * IpcResult object.  A plain string (not a Symbol) is required because
 * Electron's structured-clone IPC serialiser silently drops Symbol-keyed
 * properties.  The UUID suffix prevents accidental collision with normal
 * domain objects that happen to carry an `ok` field.
 *
 * MIGRATION
 * ---------
 * This file is the T1 foundation.  T2–T4 will migrate individual channel
 * handlers onto this contract.  Until a handler is migrated its existing
 * throw/sentinel/GitError path is preserved by the router; the two paths
 * co-exist without conflict.
 */

// ---------------------------------------------------------------------------
// Brand
// ---------------------------------------------------------------------------

/** Fixed discriminant property name.  UUID suffix prevents domain collisions. */
export const IPC_RESULT_BRAND = "__nexusIpcResult_a3f8b1d2" as const;

// ---------------------------------------------------------------------------
// Kind enum — extensible set of expected-failure categories
// ---------------------------------------------------------------------------

/**
 * Canonical set of expected-failure categories understood by the router and
 * renderer.  Handlers MAY extend this union in domain-specific types; the
 * router passes any IpcResult through regardless of the kind value, so new
 * kinds can be introduced in handler code without touching the router.
 *
 * Add new kinds here as additional channels are migrated in T2–T4.
 */
export type IpcResultKind =
  | "not-found"
  | "cancelled"
  | "session-expired"
  | "auth-failed"
  | "permission-denied"
  | "conflict"
  | "invalid-args"
  | (string & {}); // keeps the type extensible while still IDE-completing the known literals

// ---------------------------------------------------------------------------
// Result shapes
// ---------------------------------------------------------------------------

/**
 * Successful call result.  `value` carries the domain payload — whatever the
 * handler would normally return when everything goes well.
 */
export interface IpcOkResult<T = unknown> {
  readonly [IPC_RESULT_BRAND]: true;
  readonly ok: true;
  readonly value: T;
}

/**
 * Expected-failure result.  `kind` is a discriminable category from
 * `IpcResultKind`; `message` is a human-readable description for logging or
 * display.  Handlers may attach additional domain fields alongside these
 * required ones — the router forwards the object as-is.
 */
export interface IpcErrResult<K extends IpcResultKind = IpcResultKind> {
  readonly [IPC_RESULT_BRAND]: true;
  readonly ok: false;
  readonly kind: K;
  readonly message: string;
}

/**
 * Union of the two result shapes.  Handlers return `IpcResult<T>` when they
 * want the router to pass the value through without logging.
 */
export type IpcResult<T = unknown, K extends IpcResultKind = IpcResultKind> =
  | IpcOkResult<T>
  | IpcErrResult<K>;

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

/**
 * Returns `true` iff `value` is any IpcResult envelope (ok or err).
 * Checks the brand property before touching `ok`, so arbitrary objects with an
 * `ok` field never match.
 */
export function isIpcResult(value: unknown): value is IpcResult {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<string, unknown>)[IPC_RESULT_BRAND] === true
  );
}

/**
 * Returns `true` iff `value` is a successful IpcResult (ok === true).
 */
export function isIpcOkResult<T>(value: unknown): value is IpcOkResult<T> {
  return isIpcResult(value) && value.ok === true;
}

/**
 * Returns `true` iff `value` is an expected-failure IpcResult (ok === false).
 */
export function isIpcErrResult<K extends IpcResultKind = IpcResultKind>(
  value: unknown,
): value is IpcErrResult<K> {
  return isIpcResult(value) && value.ok === false;
}

// ---------------------------------------------------------------------------
// Constructors
// ---------------------------------------------------------------------------

/**
 * Build a success IpcResult.  Handlers call this to wrap their domain value
 * before returning it, signalling to the router that this is an intentional
 * result (not a bug).
 *
 * @example
 *   return ipcOk({ sessionId: "…" });
 */
export function ipcOk<T>(value: T): IpcOkResult<T> {
  return { [IPC_RESULT_BRAND]: true, ok: true, value };
}

/**
 * Build an expected-failure IpcResult.  Handlers call this instead of throwing
 * when the failure is a predictable outcome that callers can act on.
 *
 * @example
 *   return ipcErr("not-found", "Workspace not found");
 *   return ipcErr("auth-failed", "SSH key rejected", { host: "example.com" });
 */
export function ipcErr<K extends IpcResultKind>(
  kind: K,
  message: string,
  extra?: Record<string, unknown>,
): IpcErrResult<K> & Record<string, unknown> {
  return { [IPC_RESULT_BRAND]: true, ok: false, kind, message, ...extra };
}
