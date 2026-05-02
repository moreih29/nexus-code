import { z } from "zod";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type CallHandlers = Record<string, (args: unknown) => Promise<unknown> | unknown>;
type ListenHandlers = Record<string, unknown>;

interface ChannelDef {
  call: CallHandlers;
  listen: ListenHandlers;
}

const channels = new Map<string, ChannelDef>();

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
  ipcMain.handle(
    "ipc:call",
    async (
      _event: import("electron").IpcMainInvokeEvent,
      channelName: string,
      method: string,
      args: unknown
    ) => {
      const channel = channels.get(channelName);
      if (!channel) {
        throw new Error(`ipc:call — unknown channel: ${channelName}`);
      }
      const handler = channel.call[method];
      if (typeof handler !== "function") {
        throw new Error(`ipc:call — unknown method: ${channelName}.${method}`);
      }
      return handler(args);
    }
  );
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
