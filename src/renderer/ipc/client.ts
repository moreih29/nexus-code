import { createAbortError } from "../../shared/abort";
import { GIT_IPC_ERROR_KIND, type GitIpcErrorResult } from "../../shared/git/error-ipc";
import {
  IPC_RESULT_BRAND,
  type IpcErrResult,
  type IpcOkResult,
  type IpcResult,
  type IpcResultKind,
  ipcErrorToAppError,
  isIpcErrResult,
  isIpcOkResult,
  isIpcResult,
} from "../../shared/ipc/result";
import { unwrapRemoteError } from "./remote-error";
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
  onProgress(callback: (data: TProgress) => void): void;
  cancel(): void;
}

let nextRequestId = 1;

function createRequestId(): IpcRequestId {
  return `renderer-${nextRequestId++}`;
}

export function ipcCallResult<C extends CallChannels, M extends CallMethods<C>>(
  channel: C,
  method: M,
  args: CallArgs<C, M>,
  opts: IpcCallOptions = {},
): Promise<IpcResult<CallReturn<C, M>>> {
  const signal = opts.signal;

  const wrapRaw = (value: unknown): IpcResult<CallReturn<C, M>> => {
    if (isIpcResult(value)) return value as IpcResult<CallReturn<C, M>>;
    return { [IPC_RESULT_BRAND]: true, ok: true, value: value as CallReturn<C, M> };
  };

  const handleRejection = (error: unknown): never => {
    if (error instanceof Error && error.name === "AbortError") throw error;
    throw unwrapRemoteError(error);
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

export function unwrapIpcResult<T>(result: IpcResult<T>): T {
  if (result.ok) return result.value;
  const err = new Error(result.message);
  err.name = `IpcError[${result.kind}]`;
  throw Object.assign(err, ipcErrorToAppError(result), { kind: result.kind });
}

export function mustSucceed<T>(result: IpcResult<T>): T {
  return unwrapIpcResult(result);
}

export function unwrapGitResult<T>(result: IpcResult<T>): T {
  if (result.ok) return result.value;
  if (result.kind === "cancelled") throw createAbortError();
  if (result.kind === GIT_IPC_ERROR_KIND) {
    const r = result as unknown as GitIpcErrorResult;
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
  return unwrapIpcResult(result);
}

export type { IpcErrResult, IpcOkResult, IpcResult, IpcResultKind };
export { isIpcErrResult, isIpcOkResult, isIpcResult };

export function ipcListen<C extends ListenChannels, E extends ListenEvents<C>>(
  channel: C,
  event: E,
  callback: (args: ListenArg<C, E>) => void,
): () => void {
  return window.ipc.listen(channel, event, callback);
}

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
      (result) => {
        try {
          streamId = unwrapIpcResult(result).streamId;
        } catch (error) {
          settleReject(error);
          return;
        }
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

function createStreamError(data: unknown): Error {
  if (isAppErrorLike(data)) {
    if (data.category === "cancelled") {
      return createAbortError();
    }

    const error = new Error(data.message);

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

    if (data.domain) {
      error.name = `${data.domain[0]?.toUpperCase() ?? ""}${data.domain.slice(1)}Error`;
    }

    return error;
  }

  if (isErrorLike(data)) {
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

function isErrorLike(data: unknown): data is { name?: string; message: string; cause?: unknown } {
  return (
    typeof data === "object" &&
    data !== null &&
    "message" in data &&
    typeof (data as Record<string, unknown>).message === "string" &&
    (!("name" in data) || typeof (data as Record<string, unknown>).name === "string")
  );
}

export function canUseIpcBridge(): boolean {
  return typeof window !== "undefined" && "ipc" in window;
}
