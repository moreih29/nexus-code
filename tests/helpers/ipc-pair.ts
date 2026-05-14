import { mock } from "bun:test";

export type InMemoryStreamEvent =
  | { streamId: string; kind: "progress"; data: unknown }
  | { streamId: string; kind: "complete"; data: unknown }
  | { streamId: string; kind: "error"; data: unknown };

type IpcMainInvokeEvent = { sender: InMemoryWebContents };
type IpcMainEvent = { sender: InMemoryWebContents };
type IpcMainHandle = (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown> | unknown;
type IpcMainListener = (event: IpcMainEvent, ...args: unknown[]) => void;
type ListenCallback = (args: unknown) => void;
type StreamEventCallback = (event: InMemoryStreamEvent) => void;

const ipcMainHandlers = new Map<string, IpcMainHandle>();
const ipcMainListeners = new Map<string, Set<IpcMainListener>>();
const allWebContents = new Set<InMemoryWebContents>();

export const mockIpcMain = {
  handle: mock((channel: string, handler: IpcMainHandle) => {
    ipcMainHandlers.set(channel, handler);
  }),
  on: mock((channel: string, listener: IpcMainListener) => {
    let listeners = ipcMainListeners.get(channel);
    if (!listeners) {
      listeners = new Set();
      ipcMainListeners.set(channel, listeners);
    }
    listeners.add(listener);
  }),
};

export const mockGetAllWebContents = mock(() => Array.from(allWebContents));

mock.module("electron", () => ({
  ipcMain: mockIpcMain,
  webContents: {
    getAllWebContents: mockGetAllWebContents,
  },
  shell: {
    showItemInFolder: mock((_path: string) => {}),
  },
}));

export class InMemoryWebContents {
  readonly id: number;
  readonly sent: { channel: string; args: unknown[] }[] = [];
  readonly streamEvents: InMemoryStreamEvent[] = [];
  private destroyed = false;
  private readonly streamListeners = new Map<string, StreamEventCallback>();
  private readonly eventListeners = new Map<string, Set<ListenCallback>>();

  constructor(id: number) {
    this.id = id;
  }

  send(channel: string, ...args: unknown[]): void {
    this.sent.push({ channel, args });

    if (channel === "ipc:streamEvent") {
      const event = args[0] as InMemoryStreamEvent;
      this.streamEvents.push(event);
      this.streamListeners.get(event.streamId)?.(event);
      return;
    }

    if (channel === "ipc:event") {
      const [channelName, eventName, payload] = args as [string, string, unknown];
      const listeners = this.eventListeners.get(`${channelName}:${eventName}`);
      if (!listeners) return;
      for (const listener of Array.from(listeners)) {
        listener(payload);
      }
    }
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }

  destroy(): void {
    this.destroyed = true;
    this.streamListeners.clear();
    this.eventListeners.clear();
  }

  onStreamEvent(streamId: string, callback: StreamEventCallback): () => void {
    this.streamListeners.set(streamId, callback);
    return () => {
      if (this.streamListeners.get(streamId) === callback) {
        this.streamListeners.delete(streamId);
      }
    };
  }

  hasStreamListener(streamId: string): boolean {
    return this.streamListeners.has(streamId);
  }

  listen(channelName: string, eventName: string, callback: ListenCallback): void {
    const key = `${channelName}:${eventName}`;
    let listeners = this.eventListeners.get(key);
    if (!listeners) {
      listeners = new Set();
      this.eventListeners.set(key, listeners);
    }
    listeners.add(callback);
  }

  off(channelName: string, eventName: string, callback: ListenCallback): void {
    this.eventListeners.get(`${channelName}:${eventName}`)?.delete(callback);
  }
}

export interface InMemoryIpcPair {
  sender: InMemoryWebContents;
  window: {
    ipc: {
      call: (
        channelName: string,
        method: string,
        args: unknown,
        requestId?: string,
      ) => Promise<unknown>;
      cancel: (requestId: string) => void;
      streamStart: (
        channelName: string,
        method: string,
        args: unknown,
      ) => Promise<{ streamId: string }>;
      onStreamEvent: (streamId: string, callback: StreamEventCallback) => () => void;
      listen: (channelName: string, eventName: string, callback: ListenCallback) => void;
      off: (channelName: string, eventName: string, callback: ListenCallback) => void;
    };
    host: { platform: NodeJS.Platform };
  };
  streamStartCalls: {
    channelName: string;
    method: string;
    args: unknown;
    result: { streamId: string };
  }[];
}

let nextWebContentsId = 1;

export function resetInMemoryIpc(): void {
  for (const wc of allWebContents) {
    wc.destroy();
  }
  allWebContents.clear();
  ipcMainHandlers.clear();
  ipcMainListeners.clear();
  mockIpcMain.handle.mockClear();
  mockIpcMain.on.mockClear();
  mockGetAllWebContents.mockClear();
  nextWebContentsId = 1;
  delete (globalThis as { window?: unknown }).window;
}

export function createIpcPair(): InMemoryIpcPair {
  const sender = new InMemoryWebContents(nextWebContentsId++);
  const streamStartCalls: InMemoryIpcPair["streamStartCalls"] = [];
  allWebContents.add(sender);

  const pair: InMemoryIpcPair = {
    sender,
    streamStartCalls,
    window: {
      ipc: {
        call(channelName, method, args, requestId) {
          return invokeIpcMain(sender, "ipc:call", channelName, method, args, requestId);
        },
        cancel(requestId) {
          emitIpcMain(sender, "ipc:cancel", requestId);
        },
        async streamStart(channelName, method, args) {
          const result = (await invokeIpcMain(
            sender,
            "ipc:streamStart",
            channelName,
            method,
            args,
          )) as { streamId: string };
          streamStartCalls.push({ channelName, method, args, result });
          return result;
        },
        onStreamEvent(streamId, callback) {
          return sender.onStreamEvent(streamId, callback);
        },
        listen(channelName, eventName, callback) {
          sender.listen(channelName, eventName, callback);
        },
        off(channelName, eventName, callback) {
          sender.off(channelName, eventName, callback);
        },
      },
      host: { platform: process.platform },
    },
  };

  return pair;
}

export function installWindowForPair(pair: InMemoryIpcPair): void {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    writable: true,
    value: pair.window,
  });
}

export async function setupInMemoryRouter(): Promise<typeof import("../../src/main/infra/ipc/router")> {
  const router = await import("../../src/main/infra/ipc/router");
  router.setupRouter();
  return router;
}

export async function waitFor(predicate: () => boolean, failureMessage: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(failureMessage);
}

async function invokeIpcMain(
  sender: InMemoryWebContents,
  channel: string,
  ...args: unknown[]
): Promise<unknown> {
  const handler = ipcMainHandlers.get(channel);
  if (!handler) {
    throw new Error(`missing ipcMain.handle registration for ${channel}`);
  }
  return await handler({ sender }, ...args);
}

function emitIpcMain(sender: InMemoryWebContents, channel: string, ...args: unknown[]): void {
  const listeners = ipcMainListeners.get(channel);
  if (!listeners) return;
  for (const listener of Array.from(listeners)) {
    listener({ sender }, ...args);
  }
}
