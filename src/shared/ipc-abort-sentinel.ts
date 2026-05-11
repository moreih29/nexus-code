/**
 * Sentinel value returned by the ipc:call router when the main-side handler
 * throws (or rejects) and the renderer had already aborted the request.
 *
 * Electron's `ipcMain.handle` logs every rejected handler promise as
 * "Error occurred in handler for 'ipc:call'".  Normal user cancellations
 * (diff-tab unmount, search clear, …) cause exactly this: the AbortSignal
 * fires, the handler throws, and the log floods.
 *
 * The fix: when a call's signal is aborted the router catches the error,
 * RESOLVES with this sentinel instead of rejecting, and the renderer-side
 * `ipcCall` wrapper detects the sentinel and re-throws an AbortError locally
 * — same semantics for callers, zero main-process log noise.
 *
 * IMPORTANT: The discriminant must be a plain string property, NOT a Symbol.
 * Symbol-keyed properties are silently dropped by Electron's structured-clone
 * IPC serialisation, so a Symbol would pass on the main side but disappear
 * before the renderer sees it.
 */

/** Fixed discriminant property name.  The UUID suffix prevents collisions. */
export const IPC_ABORT_SENTINEL_TAG = "__nexusIpcAborted_5d7e9c2a" as const;

/** Frozen sentinel object that travels across the IPC boundary as a resolve value. */
export const IPC_ABORT_SENTINEL = Object.freeze({
  [IPC_ABORT_SENTINEL_TAG]: true,
} as const);

/**
 * Type guard: returns `true` iff `value` is the IPC_ABORT_SENTINEL.
 * Checks both that the discriminant property is present AND that its value
 * is exactly `true` (not merely truthy) so a plain `{ __nexusIpcAborted_5d7e9c2a: false }`
 * does not incorrectly match.
 */
export function isIpcAbortSentinel(
  value: unknown,
): value is { readonly [IPC_ABORT_SENTINEL_TAG]: true } {
  return (
    typeof value === "object" &&
    value !== null &&
    IPC_ABORT_SENTINEL_TAG in value &&
    (value as Record<string, unknown>)[IPC_ABORT_SENTINEL_TAG] === true
  );
}
