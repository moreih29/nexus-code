/**
 * Shared helpers for AbortError — detection, creation, and signal guard.
 */

/**
 * Returns `true` when `error` is an AbortError (i.e. the standard shape
 * produced by AbortController or by `createAbortError` helpers in this repo).
 */
export function isAbortError(error: unknown): error is Error {
  return error instanceof Error && error.name === "AbortError";
}

/**
 * Constructs the standard AbortError shape used across cancellable operations.
 * The default message matches the DOMException AbortError convention used
 * throughout this codebase.
 */
export function createAbortError(message = "The operation was aborted"): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

/**
 * Throws a standard AbortError when the supplied signal is already aborted.
 * A no-op when `signal` is undefined or not yet aborted.
 */
export function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw createAbortError();
}
