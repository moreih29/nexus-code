import * as crypto from "node:crypto";
import type { WebContents } from "electron";
import type { z } from "zod";
import { createAbortError } from "../../../shared/abort";
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
import {
  type IpcErrResult,
  type IpcStreamStartResult,
  ipcErr,
  ipcOk,
  isIpcErrResult,
} from "../../../shared/ipc/result";
import { createLogger } from "../../../shared/log/main";
import { GitError } from "../../features/git/domain/error";
import { agentCallError } from "./agent-errors";
import { fsCallError } from "./fs-errors";

const log = createLogger("main");

export interface CallContext {
  requestId?: string;
  signal?: AbortSignal;
  correlationId?: string;
  /** The renderer that called; window handlers act on its window. */
  sender?: WebContents;
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
  releaseSender?: () => void;
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

/** Signals argument validation failure to the IPC boundary. */
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
      const methods = channels.get(channelName)?.call;
      const handler = methods && Object.hasOwn(methods, method) ? methods[method] : undefined;
      if (typeof handler !== "function") {
        return ipcErr("invalid-args", `Unknown IPC call: ${channelName}.${method}`, {
          category: "invalid-input",
        });
      }
      const correlationId = crypto.randomUUID();
      const callContext = createCallContext(event, requestId, correlationId);
      const procedure = `${channelName}.${method}`;
      try {
        const result = await handler(args, callContext.ctx);
        if (isIpcErrResult(result) && result.category === "bug") {
          return {
            ...result,
            ...reportCallBug(procedure, correlationId, result.message),
            kind: result.kind,
          };
        }
        return result;
      } catch (error) {
        if (error instanceof IpcValidationError) {
          return ipcErr("invalid-args", error.message, { category: "invalid-input" });
        }
        const expected = fsCallError(error) ?? agentCallError(error);
        if (expected) return expected;
        const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
        return reportCallBug(procedure, correlationId, detail);
      } finally {
        callContext.release?.();
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
    ): Promise<IpcStreamStartResult> => {
      const methods = channels.get(channelName)?.stream;
      const handler = methods && Object.hasOwn(methods, method) ? methods[method] : undefined;
      const descriptor = getStreamDescriptor(channelName, method);
      if (typeof handler !== "function" || !descriptor) {
        return ipcErr("invalid-args", `Unknown IPC stream: ${channelName}.${method}`, {
          category: "invalid-input",
        });
      }
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
      pendingStream.releaseSender = trackSender(event.sender, () => {
        detachStream(key, pendingStream);
        pendingStream.controller.abort();
        void closeStreamGenerator(pendingStream);
      });
      setImmediate(() => {
        void runStream(key, pendingStream, descriptor, handler, args);
      });
      return ipcOk({ streamId });
    },
  );
}

/** Records the original detail while exposing only a correlation ID and safe message. */
function reportCallBug(procedure: string, correlationId: string, detail: string): IpcErrResult {
  log.error(`ipc:call — ${procedure}: ${detail}`, { correlationId });
  return ipcErr("bug", "An unexpected error occurred", { category: "bug", correlationId });
}

interface SenderLifetime {
  readonly cleanup: Set<() => void>;
  readonly destroyed: () => void;
}

const senderLifetimes = new WeakMap<WebContents, SenderLifetime>();

/** Owns pending work with one destroy listener per renderer. */
function trackSender(sender: WebContents | undefined, abandon: () => void): () => void {
  if (!sender?.once) return () => {};
  if (sender.isDestroyed()) {
    abandon();
    return () => {};
  }

  let lifetime = senderLifetimes.get(sender);
  if (!lifetime) {
    const cleanup = new Set<() => void>();
    const destroyed = () => {
      senderLifetimes.delete(sender);
      const callbacks = [...cleanup];
      cleanup.clear();
      for (const cancel of callbacks) cancel();
    };
    lifetime = { cleanup, destroyed };
    senderLifetimes.set(sender, lifetime);
    sender.once("destroyed", destroyed);
  }
  const { cleanup, destroyed } = lifetime;
  cleanup.add(abandon);
  return () => {
    if (!cleanup.delete(abandon) || cleanup.size > 0) return;
    sender.removeListener("destroyed", destroyed);
    senderLifetimes.delete(sender);
  };
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
): { release?: () => void; ctx: CallContext } {
  const sender = event.sender;
  if (typeof requestId !== "string" || requestId.length === 0) {
    return { ctx: { correlationId, sender } };
  }
  const key = requestKey(event, requestId);
  const controller = new AbortController();
  pendingCallControllers.set(key, controller);
  const remove = () => {
    if (pendingCallControllers.get(key) === controller) pendingCallControllers.delete(key);
  };
  const releaseSender = trackSender(sender, () => {
    remove();
    controller.abort();
  });
  if (consumePreCanceledRequest(key)) controller.abort();
  return {
    release: () => {
      remove();
      releaseSender();
    },
    ctx: { requestId, signal: controller.signal, correlationId, sender },
  };
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

/** Drops routing and renderer ownership before waiting for handler cleanup. */
function detachStream(key: string, pendingStream: PendingStream): void {
  pendingStream.closed = true;
  if (pendingStreamControllers.get(key) === pendingStream) pendingStreamControllers.delete(key);
  pendingStream.releaseSender?.();
}

/** Returns an unfinished iterator once, including one supplied after cancellation. */
async function closeStreamGenerator(pendingStream: PendingStream): Promise<void> {
  if (!pendingStream.generator || pendingStream.generatorDone) return;
  pendingStream.generatorDone = true;
  await pendingStream.generator.return(undefined).catch(() => {});
}

async function cleanupStream(key: string, pendingStream: PendingStream): Promise<void> {
  detachStream(key, pendingStream);
  await closeStreamGenerator(pendingStream);
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
  detachStream(key, pendingStream);
  void closeStreamGenerator(pendingStream);
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

/**
 * WebContents that show third-party pages: embedded browser tabs, their
 * popups and DevTools. They have no preload, so no page script can read an
 * event, but broadcasts carry terminal output, OAuth redirect URLs, page
 * snapshots and SSH prompts, and none of that belongs in the renderer
 * process of an arbitrary website. Keyed by id; ids are never reused.
 */
const excludedFromBroadcast = new Set<number>();

/**
 * Keeps app broadcasts out of `wc` for the rest of its life.
 */
export function excludeFromBroadcast(wc: WebContents): void {
  if (excludedFromBroadcast.has(wc.id)) return;
  excludedFromBroadcast.add(wc.id);
  wc.once("destroyed", () => {
    excludedFromBroadcast.delete(wc.id);
  });
}

export function broadcast(channelName: string, event: string, args: unknown): void {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { webContents } = require("electron") as typeof import("electron");
  const all = webContents.getAllWebContents();
  for (const wc of all) {
    if (wc.isDestroyed() || excludedFromBroadcast.has(wc.id)) continue;
    try {
      wc.send("ipc:event", channelName, event, args);
    } catch {
      /* render frame disposed */
    }
  }
}

/** Parses handler arguments and lets the router envelope validation failures. */
export function validateArgs<T extends z.ZodTypeAny>(schema: T, args: unknown): z.infer<T> {
  const parsed = schema.safeParse(args);
  if (!parsed.success) {
    throw new IpcValidationError(`ipc:call — invalid args: ${parsed.error.message}`);
  }
  return parsed.data as z.infer<T>;
}
