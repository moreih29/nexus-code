import { contextBridge, ipcRenderer } from "electron";

type ListenCallback = (args: unknown) => void;
type StreamEvent = {
  streamId: string;
  kind: "progress" | "complete" | "error";
  data: unknown;
};
type StreamEventCallback = (event: StreamEvent) => void;
type IpcRequestId = string;

// key: `${channel}:${event}` → Set of callbacks
const listeners = new Map<string, Set<ListenCallback>>();
const streamListeners = new Map<string, StreamEventCallback>();

// Single ipc:event subscription — demultiplexes into per-key sets
ipcRenderer.on("ipc:event", (_event, channelName: string, eventName: string, args: unknown) => {
  const key = `${channelName}:${eventName}`;
  const set = listeners.get(key);
  if (set) {
    for (const cb of set) {
      cb(args);
    }
  }
});

ipcRenderer.on("ipc:streamEvent", (_event, payload: StreamEvent) => {
  const { streamId } = payload;
  const callback = streamListeners.get(streamId);
  if (!callback) {
    console.warn("[ipcStream] unknown streamId", streamId);
    return;
  }
  callback(payload);
});

const ipcApi = {
  call(
    channelName: string,
    method: string,
    args: unknown,
    requestId?: IpcRequestId,
  ): Promise<unknown> {
    return ipcRenderer.invoke("ipc:call", channelName, method, args, requestId);
  },

  cancel(requestId: IpcRequestId): void {
    ipcRenderer.send("ipc:cancel", requestId);
  },

  streamStart(channelName: string, method: string, args: unknown): Promise<{ streamId: string }> {
    return ipcRenderer.invoke("ipc:streamStart", channelName, method, args);
  },

  onStreamEvent(streamId: string, callback: StreamEventCallback): () => void {
    streamListeners.set(streamId, callback);
    return () => {
      if (streamListeners.get(streamId) === callback) {
        streamListeners.delete(streamId);
      }
    };
  },

  listen(channelName: string, eventName: string, callback: ListenCallback): void {
    const key = `${channelName}:${eventName}`;
    let set = listeners.get(key);
    if (!set) {
      set = new Set();
      listeners.set(key, set);
    }
    set.add(callback);
  },

  off(channelName: string, eventName: string, callback: ListenCallback): void {
    const key = `${channelName}:${eventName}`;
    listeners.get(key)?.delete(callback);
  },
};

contextBridge.exposeInMainWorld("ipc", ipcApi);

// Static host info — exposed once at preload time so the renderer can adapt
// chrome (e.g. titlebar padding) without an IPC round-trip.
contextBridge.exposeInMainWorld("host", {
  platform: process.platform as NodeJS.Platform,
});
