import {
  gitErrorFromIpcResult,
  isIpcGitErrorResult,
  rehydrateGitErrorFromCause,
} from "../../shared/git-error-ipc";
import { isIpcAbortSentinel } from "../../shared/ipc-abort-sentinel";
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

/**
 * Type-safe `ipc:call` from the renderer. Channel + method + args are
 * checked against the IPC contract so a stale schema fails compilation
 * rather than at runtime.
 *
 * Pass `opts.signal` to make the call cancellable: aborting the signal
 * sends an `ipc:cancel` to the matching main-side request and the
 * returned promise rejects with the abort. Without a signal the call is
 * fire-and-forget for cancellation purposes.
 */
export function ipcCall<C extends CallChannels, M extends CallMethods<C>>(
  channel: C,
  method: M,
  args: CallArgs<C, M>,
  opts: IpcCallOptions = {},
): Promise<CallReturn<C, M>> {
  const signal = opts.signal;
  if (!signal) {
    return (window.ipc.call(channel, method, args) as Promise<unknown>)
      .then(unwrapCallResult<CallReturn<C, M>>)
      .catch(rethrowRehydratedGitError);
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
      .then((value) => {
        if (isIpcAbortSentinel(value)) throw createAbortError();
        return unwrapCallResult<CallReturn<C, M>>(value);
      })
      .catch(rethrowRehydratedGitError)
      .finally(() => {
        signal.removeEventListener("abort", cancel);
      });
  } catch (err) {
    signal.removeEventListener("abort", cancel);
    throw rehydrateIfPossible(err);
  }
}

/**
 * Resolves a raw `ipc:call` payload into the caller-typed value, throwing
 * the reconstructed error when the main process returned a typed Git
 * failure envelope (see `IPC_CALL_RESULT_MARK`). Done at the client edge
 * so the rest of the renderer treats expected git failures as ordinary
 * promise rejections.
 */
function unwrapCallResult<T>(value: unknown): T {
  if (isIpcGitErrorResult(value)) throw gitErrorFromIpcResult(value);
  return value as T;
}

/**
 * Throws the supplied error, restoring typed GitError fields stashed in
 * `cause` by the main-side IPC router (used for stream errors and any
 * non-call rejection that still carries the cause envelope).
 */
function rethrowRehydratedGitError(error: unknown): never {
  throw rehydrateIfPossible(error);
}

/**
 * Mutates and returns the error when it carries a GitError IPC envelope,
 * otherwise returns the original value untouched.
 */
function rehydrateIfPossible(error: unknown): unknown {
  if (error instanceof Error) rehydrateGitErrorFromCause(error);
  return error;
}

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

function createAbortError(): Error {
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
}

function createStreamError(data: unknown): Error {
  if (isErrorLike(data)) {
    const error = new Error(data.message);
    if (data.name) {
      error.name = data.name;
    }
    if ("cause" in data && data.cause !== undefined) {
      (error as { cause?: unknown }).cause = data.cause;
    }
    rehydrateGitErrorFromCause(error);
    return error;
  }

  if (typeof data === "string") {
    return new Error(data);
  }

  return new Error("Stream failed");
}

function isErrorLike(data: unknown): data is { name?: string; message: string; cause?: unknown } {
  return (
    typeof data === "object" &&
    data !== null &&
    "message" in data &&
    typeof data.message === "string" &&
    (!("name" in data) || typeof data.name === "string")
  );
}
