import type { z } from "zod";
import { PendingRequestMap } from "../../shared/pending-request-map";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CallContext {
  requestId?: string;
  signal?: AbortSignal;
}

type CallHandlers = Record<
  string,
  (args: unknown, ctx?: CallContext) => Promise<unknown> | unknown
>;
type ListenHandlers = Record<string, unknown>;

interface ChannelDef {
  call: CallHandlers;
  listen: ListenHandlers;
}

const channels = new Map<string, ChannelDef>();
const pendingCallControllers = new Map<string, AbortController>();
const preCanceledRequests = new PendingRequestMap<string, void>();
const PRECANCELED_REQUEST_TTL_MS = 30_000;

// ---------------------------------------------------------------------------
// register
// ---------------------------------------------------------------------------

export function register(channelName: string, def: ChannelDef): void {
  channels.set(channelName, def);
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
