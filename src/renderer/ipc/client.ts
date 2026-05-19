import { createAbortError } from "../../shared/abort";
import { GIT_IPC_ERROR_KIND, type GitIpcErrorResult } from "../../shared/git/error-ipc";
import {
  IPC_RESULT_BRAND,
  type IpcErrResult,
  type IpcOkResult,
  type IpcResult,
  type IpcResultKind,
  isIpcErrResult,
  isIpcOkResult,
  isIpcResult,
} from "../../shared/ipc/result";
import type {
  CallArgs,
  CallChannels,
  CallMethods,
  CallReturn,
  IpcRequestId,
  ListenArg,
  ListenChannels,
  ListenEvents,
  StreamArgs,
  StreamChannels,
  StreamComplete,
  StreamMethods,
  StreamProgress,
} from "./types";

export interface IpcCallOptions {
  signal?: AbortSignal;
}

export interface IpcStreamHandle<TProgress, TComplete> {
  promise: Promise<TComplete>;
  /**
   * Subscribe a progress callback for the lifetime of this stream. Callbacks
   * are cleared automatically when the stream settles (success, error, or
   * abort) via `cleanup()`, so callers do not manage individual unsubscribes.
   * If selective mid-stream removal is ever needed, return an unsubscribe
   * handle here — until then, the void return prevents discard-shaped
   * regressions where a returned handle would silently leak.
   */
  onProgress(callback: (data: TProgress) => void): void;
  cancel(): void;
}

let nextRequestId = 1;

function createRequestId(): IpcRequestId {
  return `renderer-${nextRequestId++}`;
}

// ---------------------------------------------------------------------------
// Result-envelope path
// ---------------------------------------------------------------------------

/**
 * Type-safe `ipc:call` from the renderer. Always resolves with an `IpcResult`
 * envelope so callers can branch on `result.ok` without relying on thrown
 * errors for expected domain failures. Cancellation (AbortSignal) is supported
 * via the optional `opts.signal` parameter.
 *
 * Non-envelope responses are wrapped into `{ ok: true, value }` so callers
 * always receive a consistent `IpcResult` shape.
 *
 * @example
 *   const result = await ipcCallResult("workspace", "testSsh", args);
 *   if (!result.ok) {
 *     showError(result.kind, result.message);
 *     return;
 *   }
 *   console.log(result.value);
 */
export function ipcCallResult<C extends CallChannels, M extends CallMethods<C>>(
  channel: C,
  method: M,
  args: CallArgs<C, M>,
  opts: IpcCallOptions = {},
): Promise<IpcResult<CallReturn<C, M>>> {
  const signal = opts.signal;

  const wrapRaw = (value: unknown): IpcResult<CallReturn<C, M>> => {
    if (isIpcResult(value)) return value as IpcResult<CallReturn<C, M>>;
    // Non-envelope response: wrap into an ok result so callers always get a
    // consistent IpcResult shape regardless of whether the handler is migrated.
    return { [IPC_RESULT_BRAND]: true, ok: true, value: value as CallReturn<C, M> };
  };

  const handleRejection = (error: unknown): never => {
    // Cancellation that arrived as a raw rejection (non-IpcResult path):
    // re-throw as AbortError so abort-aware callers branch on the same type.
    if (error instanceof Error && error.name === "AbortError") throw error;
    throw error;
  };

  if (!signal) {
    return (window.ipc.call(channel, method, args) as Promise<unknown>)
      .then(wrapRaw)
      .catch(handleRejection);
  }

  const requestId = createRequestId();
  const cancel = () => {
    window.ipc.cancel(requestId);
  };

  if (!signal.aborted) {
    signal.addEventListener("abort", cancel, { once: true });
  }

  try {
    const promise = window.ipc.call(channel, method, args, requestId) as Promise<unknown>;
    if (signal.aborted) {
      cancel();
    }
    return promise
      .then(wrapRaw)
      .catch(handleRejection)
      .finally(() => {
        signal.removeEventListener("abort", cancel);
      });
  } catch (err) {
    signal.removeEventListener("abort", cancel);
    throw err;
  }
}

/**
 * Unwrap an `IpcResult` value, throwing an Error when the result represents
 * an expected failure.  Use this when you want to treat all failures as
 * exceptions (i.e. you're in a context that already has error-boundary
 * handling) but still want the router's silent-pass-through behaviour for
 * the main side.
 *
 * @example
 *   const value = unwrapIpcResult(await ipcCallResult("ssh", "openBrowseSession", args));
 */
export function unwrapIpcResult<T>(result: IpcResult<T>): T {
  if (result.ok) return result.value;
  const err = new Error(result.message);
  err.name = `IpcError[${result.kind}]`;
  (err as unknown as Record<string, unknown>)["kind"] = result.kind;
  throw err;
}

/**
 * Explicit opt-in throw for recovery-impossible callers.
 *
 * Use when you hold an `IpcResult` and the only sensible action on failure is
 * to propagate an exception upward (e.g. inside a top-level error boundary or
 * an initialization path from which the app cannot recover gracefully).
 * Prefer `ipcCallResult` + branching on `result.ok` for all other callers.
 *
 * Unlike `unwrapIpcResult`, `mustSucceed` is intentionally named to make the
 * throw-on-failure assumption visible at every callsite.
 *
 * @example
 *   const value = mustSucceed(await ipcCallResult("workspace", "load", args));
 */
export function mustSucceed<T>(result: IpcResult<T>): T {
  return unwrapIpcResult(result);
}

/**
 * Unwrap a git-channel `IpcResult`, re-throwing `IpcErrResult<"git-error">`
 * as a typed Error with `kind`, `stderr`, `argv`, and `hint` fields that
 * `gitStoreErrorFromUnknown` can read.  `IpcErrResult<"cancelled">` is
 * converted to an AbortError so the `runOperation` abort detection path works.
 *
 * Use this helper wherever git store operations call `ipcCallResult("git", ...)`.
 * The existing `runOperation` / `failOperation` / `gitStoreErrorFromUnknown`
 * chain requires thrown errors with these fields, which this function restores.
 *
 * @example
 *   await runOperation(workspaceId, "fetch", (signal) =>
 *     unwrapGitResult(await ipcCallResult("git", "fetch", { workspaceId, remote }, { signal }))
 *   );
 */
export function unwrapGitResult<T>(result: IpcResult<T>): T {
  if (result.ok) return result.value;
  if (result.kind === "cancelled") throw createAbortError();
  if (result.kind === GIT_IPC_ERROR_KIND) {
    const r = result as unknown as GitIpcErrorResult;
    // Reconstruct a GitError-shaped Error so gitStoreErrorFromUnknown can read
    // `.kind`, `.hint`, `.stderr`, and `.argv` for the inline error banner.
    const error = new Error(r.message);
    error.name = "GitError";
    Object.assign(error, {
      kind: r.gitKind,
      stderr: r.stderr,
      argv: r.argv,
      hint: r.hint,
    });
    throw error;
  }
  // Other expected failures: throw a generic IpcError.
  const err = new Error(result.message);
  err.name = `IpcError[${result.kind}]`;
  (err as unknown as Record<string, unknown>)["kind"] = result.kind;
  throw err;
}

// Re-export result type utilities so renderer code only needs to import from
// this module rather than reaching into shared/ directly.
export type { IpcResult, IpcOkResult, IpcErrResult, IpcResultKind };
export { isIpcResult, isIpcOkResult, isIpcErrResult };

/**
 * Subscribe to a broadcast event on the given channel. Returns the
 * unsubscribe function — call it on unmount or when the listener is no
 * longer needed. The callback identity is preserved across the
 * listen / off pair so a `() => unsubscribe` adapter works correctly
 * inside React effects.
 */
export function ipcListen<C extends ListenChannels, E extends ListenEvents<C>>(
  channel: C,
  event: E,
  callback: (args: ListenArg<C, E>) => void,
): () => void {
  const cb = callback as (args: ListenArg<C, E>) => void;
  window.ipc.listen(channel, event, cb as Parameters<typeof window.ipc.listen>[2]);
  return () => {
    window.ipc.off(channel, event, cb as Parameters<typeof window.ipc.off>[2]);
  };
}

/**
 * Starts a request-scoped IPC stream.
 *
 * Register progress callbacks with `onProgress` before awaiting `promise`;
 * progress events that arrive before a callback is registered are not replayed.
 */
export function ipcStream<C extends StreamChannels, M extends StreamMethods<C>>(
  channel: C,
  method: M,
  args: StreamArgs<C, M>,
  opts: { signal?: AbortSignal } = {},
): IpcStreamHandle<StreamProgress<C, M>, StreamComplete<C, M>> {
  const progressCallbacks = new Set<(data: StreamProgress<C, M>) => void>();
  const signal = opts.signal;
  let streamId: IpcRequestId | undefined;
  let cancelSent = false;
  let abortRequested = signal?.aborted ?? false;
  let settled = false;
  let unregisterStreamEvent: (() => void) | undefined;
  let resolvePromise: (value: StreamComplete<C, M>) => void = () => {};
  let rejectPromise: (reason: unknown) => void = () => {};

  const cleanup = () => {
    unregisterStreamEvent?.();
    unregisterStreamEvent = undefined;
    signal?.removeEventListener("abort", onAbort);
    progressCallbacks.clear();
  };

  const cancelKnownStream = () => {
    if (!streamId || cancelSent) return;
    cancelSent = true;
    window.ipc.cancel(streamId);
  };

  const settleResolve = (value: StreamComplete<C, M>) => {
    if (settled) return;
    settled = true;
    cleanup();
    resolvePromise(value);
  };

  const settleReject = (reason: unknown) => {
    if (settled) return;
    settled = true;
    cleanup();
    rejectPromise(reason);
  };

  function onAbort(): void {
    abortRequested = true;
    cancelKnownStream();
    settleReject(createAbortError());
  }

  const promise = new Promise<StreamComplete<C, M>>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });

  if (signal) {
    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener("abort", onAbort, { once: true });
    }
  }

  try {
    window.ipc.streamStart(channel, method, args).then(
      ({ streamId: startedStreamId }) => {
        streamId = startedStreamId;
        if (settled) {
          if (abortRequested) cancelKnownStream();
          return;
        }

        unregisterStreamEvent = window.ipc.onStreamEvent(streamId, (event) => {
          if (settled) return;

          if (event.kind === "progress") {
            for (const callback of Array.from(progressCallbacks)) {
              callback(event.data as StreamProgress<C, M>);
            }
            return;
          }

          if (event.kind === "complete") {
            settleResolve(event.data as StreamComplete<C, M>);
            return;
          }

          settleReject(createStreamError(event.data));
        });

        if (abortRequested) {
          cancelKnownStream();
        }
      },
      (error) => {
        settleReject(error);
      },
    );
  } catch (error) {
    settleReject(error);
  }

  return {
    promise,
    onProgress(callback) {
      progressCallbacks.add(callback);
    },
    cancel() {
      abortRequested = true;
      cancelKnownStream();
    },
  };
}

/**
 * Converts a stream error payload received from `ipc:streamEvent` into a
 * renderer-side Error instance.
 *
 * The router now sends `AppError` objects (`{ category, message, domain?,
 * code?, _gitCause? }`).  Four cases are handled:
 *
 *   - `category:"cancelled"` => AbortError so abort-aware callers can detect
 *     the cancellation without inspecting `category`.
 *   - `_gitCause` present => git fields (`kind`, `stderr`, `argv`, `hint`) are
 *     copied onto the Error so existing `gitStoreErrorFromUnknown` consumers
 *     read the same shape as before the AppError migration.
 *   - Any other AppError shape => plain Error with `message` and optional
 *     domain-tagged `name`.
 *   - Legacy `{ name?, message }` shape (pre-migration payloads or test
 *     harnesses dispatching the old `SerializedError` format) => Error with
 *     `name` and `message` preserved; `cause` is rehydrated if present.
 *     This path keeps the migration window regression-free.
 */
function createStreamError(data: unknown): Error {
  if (isAppErrorLike(data)) {
    // Cancelled stream — surface as an AbortError so abort-aware callers branch
    // on the same error type as signal-based cancellations.
    if (data.category === "cancelled") {
      return createAbortError();
    }

    const error = new Error(data.message);

    // Rehydrate git-domain errors from the `_gitCause` envelope the router
    // attaches when converting a GitError to AppError format.
    const gitCause = (data as Record<string, unknown>)._gitCause;
    if (gitCause && typeof gitCause === "object") {
      const cause = gitCause as Record<string, unknown>;
      Object.assign(error, {
        kind: cause.kind,
        stderr: cause.stderr,
        argv: cause.argv,
        hint: cause.hint,
      });
      error.name = "GitError";
      return error;
    }

    // Non-git failures — assign a domain-tagged name when available.
    if (data.domain) {
      error.name = `${data.domain[0]?.toUpperCase() ?? ""}${data.domain.slice(1)}Error`;
    }

    return error;
  }

  if (isErrorLike(data)) {
    // Legacy `{ name?, message, cause? }` shape emitted by pre-migration routers
    // or injected directly by test harnesses.  Preserved so callers that rely on
    // `error.name` for error classification continue to work unchanged.
    const error = new Error(data.message);
    if (data.name) error.name = data.name;
    if ("cause" in data && data.cause !== undefined) {
      (error as { cause?: unknown }).cause = data.cause;
    }
    return error;
  }

  if (typeof data === "string") return new Error(data);
  return new Error("Stream failed");
}

/**
 * Returns true when `data` is an `AppError` payload from the router.
 * Distinguished from the legacy shape by the presence of `category`.
 */
function isAppErrorLike(
  data: unknown,
): data is { category: string; message: string; domain?: string } {
  return (
    typeof data === "object" &&
    data !== null &&
    "category" in data &&
    typeof (data as Record<string, unknown>).category === "string" &&
    "message" in data &&
    typeof (data as Record<string, unknown>).message === "string"
  );
}

/**
 * Returns true when `data` has the legacy `{ name?, message, cause? }` shape
 * emitted by pre-migration routers or test harnesses dispatching old payloads.
 */
function isErrorLike(
  data: unknown,
): data is { name?: string; message: string; cause?: unknown } {
  return (
    typeof data === "object" &&
    data !== null &&
    "message" in data &&
    typeof (data as Record<string, unknown>).message === "string" &&
    (!("name" in data) || typeof (data as Record<string, unknown>).name === "string")
  );
}

/**
 * Returns true when the preload IPC bridge is installed in the current
 * renderer context. Guards against firing IPC calls in unit-test environments
 * or non-browser contexts where the bridge is absent.
 */
export function canUseIpcBridge(): boolean {
  return typeof window !== "undefined" && "ipc" in window;
}
