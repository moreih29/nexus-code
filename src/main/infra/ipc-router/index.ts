import * as crypto from "node:crypto";
import type { z } from "zod";
import { createAbortError, isAbortError } from "../../../shared/abort";
import type { AppError } from "../../../shared/error/app-error";
import { IPC_GIT_ERROR_MARK, type IpcGitErrorPayload } from "../../../shared/git/error-ipc";
import {
  type InferArgs,
  type InferComplete,
  type InferProgress,
  ipcContract,
  type StreamProcedure,
} from "../../../shared/ipc/contract";
import { PendingRequestMap } from "../../../shared/ipc/pending-request-map";
import { type IpcErrResult, ipcErr, isIpcErrResult } from "../../../shared/ipc/result";
import { GitError } from "../../features/git/domain/error";

export interface CallContext {
  requestId?: string;
  signal?: AbortSignal;
  correlationId?: string;
}

export interface StreamContext {
  signal: AbortSignal;
}

type CallHandlers = Record<
  string,
  (args: unknown, ctx?: CallContext) => Promise<unknown> | unknown
>;
type ListenHandlers = Record<string, unknown>;
type StreamGenerator<TProgress = unknown, TComplete = unknown> = AsyncGenerator<
  TProgress,
  TComplete,
  unknown
>;
type StreamHandler<TArgs = unknown, TProgress = unknown, TComplete = unknown> = {
  handle(
    args: TArgs,
    ctx: StreamContext,
  ): StreamGenerator<TProgress, TComplete> | Promise<StreamGenerator<TProgress, TComplete>>;
}["handle"];
type AnyStreamHandler = StreamHandler;
type StreamHandlers = Record<string, AnyStreamHandler>;
type AnyStreamProcedure = StreamProcedure<z.ZodTypeAny, z.ZodTypeAny, z.ZodTypeAny>;
type IpcContract = typeof ipcContract;
type ContractChannelName = keyof IpcContract & string;
type ContractStreamProcedures<C extends ContractChannelName> = IpcContract[C] extends {
  stream: infer Procedures;
}
  ? Procedures
  : never;
type RegisteredStreamHandlers<C extends ContractChannelName> = [
  ContractStreamProcedures<C>,
] extends [never]
  ? StreamHandlers
  : {
      [M in keyof ContractStreamProcedures<C> & string]: StreamHandler<
        InferArgs<ContractStreamProcedures<C>[M]>,
        InferProgress<ContractStreamProcedures<C>[M]>,
        InferComplete<ContractStreamProcedures<C>[M]>
      >;
    };
type StreamEventPayload =
  | { streamId: string; kind: "progress"; data: unknown }
  | { streamId: string; kind: "complete"; data: unknown }
  | { streamId: string; kind: "error"; data: AppError };

interface PendingStream {
  controller: AbortController;
  cancelMode: "router" | "handler";
  sender: import("electron").WebContents;
  streamId: string;
  generator?: StreamGenerator;
  closed: boolean;
  errorSent: boolean;
  generatorDone: boolean;
}

interface ChannelDef {
  call: CallHandlers;
  listen: ListenHandlers;
  stream?: StreamHandlers;
}

interface RegisteredChannelDef<C extends ContractChannelName> {
  call: CallHandlers;
  listen: ListenHandlers;
  stream?: RegisteredStreamHandlers<C>;
}

type RegisterChannelDef<C extends string> = C extends ContractChannelName
  ? RegisteredChannelDef<C>
  : ChannelDef;

/**
 * Thrown by `validateArgs` when the caller-supplied arguments fail Zod
 * schema validation.  The `ipc:call` router catches this error at the IPC
 * boundary and converts it into an `IpcErrResult<"invalid-args">` with
 * `category:"invalid-input"` so the renderer can branch on the result
 * without catching exceptions.
 *
 * Handlers do not need to catch this error themselves — throwing it is the
 * correct signal that propagates to the router-level conversion.  Handlers
 * that opt into the result-based API should use `isIpcErrResult` on the
 * return value of `validateArgs` after T7 migration.
 */
export class IpcValidationError extends Error {
  readonly kind = "invalid-args" as const;
  readonly category = "invalid-input" as const;

  constructor(message: string) {
    super(message);
    this.name = "IpcValidationError";
  }
}

const channels = new Map<string, ChannelDef>();
const pendingCallControllers = new Map<string, AbortController>();
const pendingStreamControllers = new Map<string, PendingStream>();
const preCanceledRequests = new PendingRequestMap<string, void>();
const PRECANCELED_REQUEST_TTL_MS = 30_000;

export function register<C extends string>(channelName: C, def: RegisterChannelDef<C>): void {
  channels.set(channelName, def as ChannelDef);
}

export function setupRouter(): void {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { ipcMain } = require("electron") as typeof import("electron");
  ipcMain.on("ipc:cancel", (event: import("electron").IpcMainEvent, requestId: unknown) => {
    if (typeof requestId !== "string" || requestId.length === 0) return;
    const key = requestKey(event, requestId);
    const pending = pendingCallControllers.get(key);
    if (pending) {
      pending.abort();
      return;
    }
    const pendingStream = pendingStreamControllers.get(key);
    if (pendingStream) {
      cancelStream(key, pendingStream);
      return;
    }
    rememberPreCanceledRequest(key);
  });
  ipcMain.handle(
    "ipc:call",
    async (
      event: import("electron").IpcMainInvokeEvent,
      channelName: string,
      method: string,
      args: unknown,
      requestId?: unknown,
    ) => {
      const channel = channels.get(channelName);
      if (!channel) throw new Error(`ipc:call — unknown channel: ${channelName}`);
      const handler = channel.call[method];
      if (typeof handler !== "function")
        throw new Error(`ipc:call — unknown method: ${channelName}.${method}`);
      const correlationId = crypto.randomUUID();
      const callContext = createCallContext(event, requestId, correlationId);
      try {
        const handlerResult = await handler(args, callContext.ctx);
        if (
          isIpcErrResult(handlerResult) &&
          // `category` is an extension field set by `ipcErr(..., { category })` and
          // is not declared on the base IpcErrResult interface; cast to access it.
          (handlerResult as unknown as { category?: string }).category === "bug"
        ) {
          // Lazy-require avoids pulling electron into module scope at load time
          // (shared/log/main imports electron.app which is unavailable in test env).
          // The try-catch guards against module-cache mismatches in test workers
          // where another file already loaded the real electron without app mocked.
          try {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const { createLogger } =
              require("../../../shared/log/main") as typeof import("../../../shared/log/main");
            createLogger("main").error(
              `ipc:call — bug result from ${channelName}.${method}: ${handlerResult.message}`,
              { correlationId },
            );
          } catch {
            /* logger unavailable — suppress to allow the IpcErrResult to be returned */
          }
        }
        return handlerResult;
      } catch (error) {
        if (error instanceof IpcValidationError) {
          // Handler called validateArgs with invalid args — convert to IpcErrResult.
          // This is the router-boundary enforcement: the renderer always receives
          // a typed result rather than a raw rejection.
          return ipcErr("invalid-args", error.message, { category: "invalid-input" as const });
        }
        if (isAbortError(error)) {
          try {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const { createLogger } =
              require("../../../shared/log/main") as typeof import("../../../shared/log/main");
            createLogger("main").debug(
              `ipc:call — cancelled  ${channelName}.${method}  req=${requestId ?? "(none)"}`,
              { correlationId },
            );
          } catch {
            /* logger unavailable — suppress */
          }
          return ipcErr("cancelled", "operation cancelled");
        }
        throw error;
      } finally {
        if (callContext.key) pendingCallControllers.delete(callContext.key);
      }
    },
  );
  ipcMain.handle(
    "ipc:streamStart",
    async (
      event: import("electron").IpcMainInvokeEvent,
      channelName: string,
      method: string,
      args: unknown,
    ) => {
      const channel = channels.get(channelName);
      if (!channel) throw new Error(`ipc:streamStart — unknown channel: ${channelName}`);
      const handler = channel.stream?.[method];
      const descriptor = getStreamDescriptor(channelName, method);
      if (typeof handler !== "function" || !descriptor)
        throw new Error(`ipc:streamStart — unknown method: ${channelName}.${method}`);
      const streamId = crypto.randomUUID();
      const key = requestKey(event, streamId);
      const pendingStream: PendingStream = {
        controller: new AbortController(),
        cancelMode: descriptor.cancelMode ?? "router",
        sender: event.sender,
        streamId,
        closed: false,
        errorSent: false,
        generatorDone: false,
      };
      pendingStreamControllers.set(key, pendingStream);
      setImmediate(() => {
        void runStream(key, pendingStream, descriptor, handler, args);
      });
      return { streamId };
    },
  );
}

function senderId(event: { sender?: { id?: number } }): string {
  return typeof event.sender?.id === "number" ? String(event.sender.id) : "unknown";
}

function requestKey(event: { sender?: { id?: number } }, requestId: string): string {
  return `${senderId(event)}:${requestId}`;
}

function rememberPreCanceledRequest(key: string): void {
  if (preCanceledRequests.has(key)) preCanceledRequests.reject(key, new Error("replaced"));
  preCanceledRequests.register({ key, timeoutMs: PRECANCELED_REQUEST_TTL_MS }).catch(() => {});
}

function consumePreCanceledRequest(key: string): boolean {
  return preCanceledRequests.resolve(key, undefined);
}

function createCallContext(
  event: import("electron").IpcMainInvokeEvent,
  requestId: unknown,
  correlationId: string,
): { key?: string; ctx?: CallContext } {
  if (typeof requestId !== "string" || requestId.length === 0) {
    return { ctx: { correlationId } };
  }
  const key = requestKey(event, requestId);
  const controller = new AbortController();
  pendingCallControllers.set(key, controller);
  if (consumePreCanceledRequest(key)) controller.abort();
  return { key, ctx: { requestId, signal: controller.signal, correlationId } };
}

function getStreamDescriptor(channelName: string, method: string): AnyStreamProcedure | undefined {
  const contract = ipcContract as Record<string, { stream?: Record<string, AnyStreamProcedure> }>;
  return contract[channelName]?.stream?.[method];
}

function parseOrInvalidInput<T extends z.ZodTypeAny>(
  schema: T,
  value: unknown,
  prefix: string,
): z.infer<T> | IpcErrResult<"invalid-args"> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    return ipcErr("invalid-args", `${prefix}: ${parsed.error.message}`, {
      category: "invalid-input" as const,
    });
  }
  return parsed.data as z.infer<T>;
}

function validateStreamValue<T extends z.ZodTypeAny>(
  schema: T,
  value: unknown,
  label: "args" | "progress" | "result",
): z.infer<T> | IpcErrResult<"invalid-args"> {
  return parseOrInvalidInput(schema, value, `ipc:streamStart — invalid ${label}`);
}

async function runStream(
  key: string,
  pendingStream: PendingStream,
  descriptor: AnyStreamProcedure,
  handler: AnyStreamHandler,
  args: unknown,
): Promise<void> {
  try {
    if (shouldStopStream(key, pendingStream)) return;
    const validatedArgs = validateStreamValue(descriptor.args, args, "args");
    if (isIpcErrResult(validatedArgs)) {
      sendStreamAppError(pendingStream, validatedArgs.message, "invalid-input");
      return;
    }
    if (shouldStopStream(key, pendingStream)) return;
    const generator = await handler(validatedArgs, { signal: pendingStream.controller.signal });
    pendingStream.generator = generator;
    if (shouldStopStream(key, pendingStream)) return;
    while (true) {
      const iterResult = await generator.next();
      if (shouldStopStream(key, pendingStream)) return;
      if (iterResult.done) {
        pendingStream.generatorDone = true;
        const validated = validateStreamValue(descriptor.result, iterResult.value, "result");
        if (isIpcErrResult(validated)) {
          if (!shouldStopStream(key, pendingStream))
            sendStreamAppError(pendingStream, validated.message, "invalid-input");
          return;
        }
        if (!shouldStopStream(key, pendingStream)) {
          sendStreamEvent(pendingStream, {
            streamId: pendingStream.streamId,
            kind: "complete",
            data: validated,
          });
        }
        return;
      }
      const validated = validateStreamValue(descriptor.progress, iterResult.value, "progress");
      if (isIpcErrResult(validated)) {
        if (!shouldStopStream(key, pendingStream))
          sendStreamAppError(pendingStream, validated.message, "invalid-input");
        return;
      }
      if (!shouldStopStream(key, pendingStream)) {
        sendStreamEvent(pendingStream, {
          streamId: pendingStream.streamId,
          kind: "progress",
          data: validated,
        });
      }
    }
  } catch (error) {
    if (!pendingStream.errorSent) {
      const streamError =
        pendingStream.controller.signal.aborted && pendingStream.cancelMode !== "handler"
          ? createAbortError()
          : error;
      sendStreamError(pendingStream, streamError);
    }
  } finally {
    await cleanupStream(key, pendingStream);
  }
}

async function cleanupStream(key: string, pendingStream: PendingStream): Promise<void> {
  const shouldCloseGenerator =
    pendingStream.generator &&
    !pendingStream.generatorDone &&
    !pendingStream.closed &&
    !pendingStream.controller.signal.aborted;
  pendingStream.closed = true;
  pendingStreamControllers.delete(key);
  if (shouldCloseGenerator) await pendingStream.generator?.return(undefined).catch(() => {});
}

function shouldStopStream(key: string, pendingStream: PendingStream): boolean {
  return (
    pendingStream.closed ||
    (pendingStream.controller.signal.aborted && pendingStream.cancelMode !== "handler") ||
    pendingStreamControllers.get(key) !== pendingStream
  );
}

function cancelStream(key: string, pendingStream: PendingStream): void {
  pendingStream.controller.abort();
  if (pendingStream.cancelMode === "handler") return;
  sendStreamError(pendingStream, createAbortError());
  pendingStream.closed = true;
  pendingStreamControllers.delete(key);
  void pendingStream.generator?.return(undefined).catch(() => {});
}

function sendStreamEvent(pendingStream: PendingStream, payload: StreamEventPayload): void {
  if (!pendingStream.sender.isDestroyed()) pendingStream.sender.send("ipc:streamEvent", payload);
}

function sendStreamError(pendingStream: PendingStream, error: unknown): void {
  if (pendingStream.errorSent) return;
  pendingStream.errorSent = true;
  sendStreamEvent(pendingStream, {
    streamId: pendingStream.streamId,
    kind: "error",
    data: errorToAppError(error),
  });
}

function sendStreamAppError(
  pendingStream: PendingStream,
  message: string,
  category: AppError["category"],
): void {
  if (pendingStream.errorSent) return;
  pendingStream.errorSent = true;
  sendStreamEvent(pendingStream, {
    streamId: pendingStream.streamId,
    kind: "error",
    data: { category, message },
  });
}

function errorToAppError(error: unknown): AppError {
  if (error instanceof GitError) {
    const gitPayload: IpcGitErrorPayload = {
      [IPC_GIT_ERROR_MARK]: true,
      kind: error.kind,
      stderr: error.stderr,
      argv: error.argv,
      hint: error.hint,
    };
    return {
      category: "failed",
      domain: "git",
      code: error.kind,
      message: error.message,
      ...{ _gitCause: gitPayload },
    } as AppError & { _gitCause: IpcGitErrorPayload };
  }
  if (error instanceof Error) {
    const category: AppError["category"] = error.name === "AbortError" ? "cancelled" : "failed";
    return { category, message: error.message };
  }
  if (typeof error === "string") return { category: "failed", message: error };
  return { category: "bug", message: "Unknown stream error" };
}

export function broadcast(channelName: string, event: string, args: unknown): void {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { webContents } = require("electron") as typeof import("electron");
  const all = webContents.getAllWebContents();
  for (const wc of all) {
    if (wc.isDestroyed()) continue;
    try {
      wc.send("ipc:event", channelName, event, args);
    } catch {
      /* render frame disposed */
    }
  }
}

/**
 * Validate handler arguments against a Zod schema.
 *
 * On success returns the parsed (typed) value.  On failure throws
 * `IpcValidationError` — the `ipc:call` router catches this at the IPC
 * boundary and converts it into an `IpcErrResult<"invalid-args">` with
 * `category:"invalid-input"` so the renderer always receives a typed result.
 *
 * Handlers do not need to catch `IpcValidationError` themselves.  Handlers
 * that adopt the result-based API (T7 migration) should instead call this
 * function and check `isIpcErrResult` on the return — until then the throw
 * path is fully supported and backward-compatible with all existing handlers.
 *
 * @example
 *   // Legacy throw style (pre-T7):
 *   const { workspaceId, relPath } = validateArgs(c.readdir.args, args);
 *
 *   // Result style (post-T7):
 *   const parsed = validateArgs(c.readdir.args, args);
 *   if (isIpcErrResult(parsed)) return parsed;
 *   const { workspaceId, relPath } = parsed;
 */
export function validateArgs<T extends z.ZodTypeAny>(schema: T, args: unknown): z.infer<T> {
  const parsed = schema.safeParse(args);
  if (!parsed.success) {
    throw new IpcValidationError(`ipc:call — invalid args: ${parsed.error.message}`);
  }
  return parsed.data as z.infer<T>;
}
