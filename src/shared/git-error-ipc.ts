/**
 * GitError IPC envelope — preserves typed Git error fields across the
 * Electron IPC boundary.
 *
 * Background. V8's `ValueSerializer` (used by Electron's IPC for
 * `ipcMain.handle` rejections) preserves only `name`, `message`, `stack`,
 * and `cause` on Error instances. Custom own properties such as `kind`,
 * `stderr`, `argv`, and `hint` are silently dropped. The renderer therefore
 * cannot branch on `error.kind` or render hint-driven recovery dialogs from
 * a raw thrown GitError.
 *
 * Strategy. The main-side router catches a GitError before throwing and
 * stores its typed fields under `cause` as a plain object marked with
 * `IPC_GIT_ERROR_MARK`. `cause` survives structured clone, so the marked
 * object reaches the renderer. The renderer's `ipcCall` recognizes the
 * marker and copies the fields back onto the Error instance, leaving
 * `name === "GitError"`, `message`, and `stack` untouched.
 *
 * This module owns the wire shape so `src/main/ipc/router.ts` and
 * `src/renderer/ipc/client.ts` agree on it without importing from each
 * other's process boundary.
 */

import type { GitActionHint } from "./types/git";

/** Sentinel placed on the cause object so the renderer can identify the envelope. */
export const IPC_GIT_ERROR_MARK = "__ipcGitError";

/**
 * Sentinel field on an `ipc:call` resolved value indicating that the main
 * process intentionally returned a typed Git failure as data instead of
 * throwing. Keeps Electron's `ipcMain.handle` unhandled-rejection logger
 * (`console.error("Error occurred in handler for 'ipc:call'", …)`) silent
 * for expected error paths such as `no-upstream` or `no-such-ref`.
 *
 * Wire shape:
 *
 *   { [IPC_CALL_RESULT_MARK]: true, name, message, kind, stderr, argv, hint? }
 *
 * The renderer client looks for this sentinel before treating a resolved
 * value as the call's success payload; if present, it reconstructs the
 * original Error and rejects the call instead.
 */
export const IPC_CALL_RESULT_MARK = "__ipcGitErrorResult";

export interface IpcGitErrorResult {
  readonly [IPC_CALL_RESULT_MARK]: true;
  readonly name: string;
  readonly message: string;
  readonly stack?: string;
  readonly kind: string;
  readonly stderr: string;
  readonly argv: readonly string[];
  readonly hint?: GitActionHint;
}

/**
 * True when a value is the envelope produced by `wrapGitErrorAsResult`.
 */
export function isIpcGitErrorResult(value: unknown): value is IpcGitErrorResult {
  if (!value || typeof value !== "object") return false;
  return (value as Record<string, unknown>)[IPC_CALL_RESULT_MARK] === true;
}

/**
 * Reconstructs an Error instance equivalent to the GitError that the main
 * process caught. The result has `name === "GitError"` plus typed fields
 * (`kind`, `hint`, `stderr`, `argv`) so existing `gitStoreErrorFromUnknown`
 * code paths read identical data whether the error arrived via throw +
 * cause envelope (legacy/stream path) or via this result envelope.
 */
export function gitErrorFromIpcResult(result: IpcGitErrorResult): Error {
  const error = new Error(result.message);
  error.name = result.name || "GitError";
  if (result.stack) error.stack = result.stack;
  Object.assign(error, {
    kind: result.kind,
    stderr: result.stderr,
    argv: result.argv,
    hint: result.hint,
  });
  return error;
}

/**
 * Wire shape carried in `Error.cause`. Mirrors the public surface of the
 * main-process `GitError` class without depending on it (so renderer code can
 * rehydrate without importing main-only modules).
 */
export interface IpcGitErrorPayload {
  readonly [IPC_GIT_ERROR_MARK]: true;
  readonly kind: string;
  readonly stderr: string;
  readonly argv: readonly string[];
  readonly hint?: GitActionHint;
}

/**
 * Detects a hydrated cause object emitted by `serializeGitErrorForIpc`.
 */
export function isIpcGitErrorPayload(value: unknown): value is IpcGitErrorPayload {
  if (!value || typeof value !== "object") return false;
  return (value as Record<string, unknown>)[IPC_GIT_ERROR_MARK] === true;
}

/**
 * Copies the payload fields onto the supplied error so renderer code can read
 * `error.kind`, `error.hint`, `error.stderr`, and `error.argv` exactly as it
 * would on the main side. Mutates in place; returns the same instance for
 * call-site convenience.
 */
export function rehydrateGitErrorFromCause(error: Error): Error {
  const cause = (error as { cause?: unknown }).cause;
  if (!isIpcGitErrorPayload(cause)) return error;

  Object.assign(error, {
    kind: cause.kind,
    stderr: cause.stderr,
    argv: cause.argv,
    hint: cause.hint,
  });
  return error;
}
