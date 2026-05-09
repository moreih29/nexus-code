import * as crypto from "node:crypto";
import type { z } from "zod";
import {
  type InferArgs,
  type InferComplete,
  type InferProgress,
  ipcContract,
  type StreamProcedure,
} from "../../shared/ipc-contract";
import { PendingRequestMap } from "../../shared/pending-request-map";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CallContext {
  requestId?: string;
  signal?: AbortSignal;
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
  | { streamId: string; kind: "error"; data: SerializedError };

interface SerializedError {
  name: string;
  message: string;
}

interface PendingStream {
  controller: AbortController;
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

const channels = new Map<string, ChannelDef>();
const pendingCallControllers = new Map<string, AbortController>();
const pendingStreamControllers = new Map<string, PendingStream>();
const preCanceledRequests = new PendingRequestMap<string, void>();
const PRECANCELED_REQUEST_TTL_MS = 30_000;

// ---------------------------------------------------------------------------
// register
// ---------------------------------------------------------------------------

export function register<C extends string>(channelName: C, def: RegisterChannelDef<C>): void {
  channels.set(channelName, def as ChannelDef);
}

// ---------------------------------------------------------------------------
// setupRouter — attach the central ipcMain handle (call once from main/index)
// ---------------------------------------------------------------------------

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
      if (!channel) {
        throw new Error(`ipc:call — unknown channel: ${channelName}`);
      }
      const handler = channel.call[method];
      if (typeof handler !== "function") {
        throw new Error(`ipc:call — unknown method: ${channelName}.${method}`);
      }

      const callContext = createCallContext(event, requestId);
      try {
        return await handler(args, callContext.ctx);
      } finally {
        if (callContext.key) {
          pendingCallControllers.delete(callContext.key);
        }
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
      if (!channel) {
        throw new Error(`ipc:streamStart — unknown channel: ${channelName}`);
      }
      const handler = channel.stream?.[method];
      const descriptor = getStreamDescriptor(channelName, method);
      if (typeof handler !== "function" || !descriptor) {
        throw new Error(`ipc:streamStart — unknown method: ${channelName}.${method}`);
      }

      const streamId = crypto.randomUUID();
      const key = requestKey(event, streamId);
      const pendingStream: PendingStream = {
        controller: new AbortController(),
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
  if (preCanceledRequests.has(key)) {
    preCanceledRequests.reject(key, new Error("replaced"));
  }
  preCanceledRequests.register({ key, timeoutMs: PRECANCELED_REQUEST_TTL_MS }).catch(() => {});
}

function consumePreCanceledRequest(key: string): boolean {
  return preCanceledRequests.resolve(key, undefined);
}

function createCallContext(
  event: import("electron").IpcMainInvokeEvent,
  requestId: unknown,
): { key?: string; ctx?: CallContext } {
  if (typeof requestId !== "string" || requestId.length === 0) {
    return {};
  }

  const key = requestKey(event, requestId);
  const controller = new AbortController();
  pendingCallControllers.set(key, controller);
  if (consumePreCanceledRequest(key)) {
    controller.abort();
  }
  return { key, ctx: { requestId, signal: controller.signal } };
}

function getStreamDescriptor(channelName: string, method: string): AnyStreamProcedure | undefined {
  const contract = ipcContract as Record<string, { stream?: Record<string, AnyStreamProcedure> }>;
  return contract[channelName]?.stream?.[method];
}

function validateStreamValue<T extends z.ZodTypeAny>(
  schema: T,
  value: unknown,
  label: "args" | "progress" | "result",
): z.infer<T> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new Error(`ipc:streamStart — invalid ${label}: ${result.error.message}`);
  }
  return result.data;
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
    if (shouldStopStream(key, pendingStream)) return;

    const generator = await handler(validatedArgs, {
      signal: pendingStream.controller.signal,
    });
    pendingStream.generator = generator;
    if (shouldStopStream(key, pendingStream)) return;

    while (true) {
      const result = await generator.next();
      if (shouldStopStream(key, pendingStream)) return;

      if (result.done) {
        pendingStream.generatorDone = true;
        const data = validateStreamValue(descriptor.result, result.value, "result");
        if (!shouldStopStream(key, pendingStream)) {
          sendStreamEvent(pendingStream, {
            streamId: pendingStream.streamId,
            kind: "complete",
            data,
          });
        }
        return;
      }

      const data = validateStreamValue(descriptor.progress, result.value, "progress");
      if (!shouldStopStream(key, pendingStream)) {
        sendStreamEvent(pendingStream, {
          streamId: pendingStream.streamId,
          kind: "progress",
          data,
        });
      }
    }
  } catch (error) {
    if (!pendingStream.errorSent) {
      const streamError = pendingStream.controller.signal.aborted ? createAbortError() : error;
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

  if (shouldCloseGenerator) {
    await pendingStream.generator?.return(undefined).catch(() => {});
  }
}

function shouldStopStream(key: string, pendingStream: PendingStream): boolean {
  return (
    pendingStream.closed ||
    pendingStream.controller.signal.aborted ||
    pendingStreamControllers.get(key) !== pendingStream
  );
}

function cancelStream(key: string, pendingStream: PendingStream): void {
  pendingStream.controller.abort();
  sendStreamError(pendingStream, createAbortError());
  pendingStream.closed = true;
  pendingStreamControllers.delete(key);
  void pendingStream.generator?.return(undefined).catch(() => {});
}

function sendStreamEvent(pendingStream: PendingStream, payload: StreamEventPayload): void {
  if (!pendingStream.sender.isDestroyed()) {
    pendingStream.sender.send("ipc:streamEvent", payload);
  }
}

function sendStreamError(pendingStream: PendingStream, error: unknown): void {
  if (pendingStream.errorSent) return;
  pendingStream.errorSent = true;
  sendStreamEvent(pendingStream, {
    streamId: pendingStream.streamId,
    kind: "error",
    data: serializeError(error),
  });
}

function createAbortError(): Error {
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
}

function serializeError(error: unknown): SerializedError {
  if (error instanceof Error) {
    return { name: error.name || "Error", message: error.message };
  }
  if (typeof error === "string") {
    return { name: "Error", message: error };
  }
  return { name: "Error", message: "Unknown error" };
}

// ---------------------------------------------------------------------------
// broadcast — send an event to all active webContents
// ---------------------------------------------------------------------------

export function broadcast(channelName: string, event: string, args: unknown): void {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { webContents } = require("electron") as typeof import("electron");
  const all = webContents.getAllWebContents();
  for (const wc of all) {
    if (!wc.isDestroyed()) {
      wc.send("ipc:event", channelName, event, args);
    }
  }
}

// ---------------------------------------------------------------------------
// validateArgs — zod parse helper used by channel implementations
// ---------------------------------------------------------------------------

export function validateArgs<T extends z.ZodTypeAny>(schema: T, args: unknown): z.infer<T> {
  const result = schema.safeParse(args);
  if (!result.success) {
    throw new Error(`ipc:call — invalid args: ${result.error.message}`);
  }
  return result.data;
}
