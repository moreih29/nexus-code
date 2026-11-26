import { contextBridge, ipcRenderer, webUtils } from "electron";
import { isNetworkOrDevicePath } from "../shared/fs/outside-url";
import {
  isWindowsLongPath,
  type PickedAttachment,
  READ_PICKED_ATTACHMENT,
  REMEMBER_PICKED_FILE,
} from "../shared/fs/picked-attachment";
import type { IpcStreamStartResult } from "../shared/ipc/result";
import { OPAQUE_WINDOW_ARG, TRANSPARENT_WINDOW_ARG } from "../shared/window/transparent-window";

type ListenCallback = (args: unknown) => void;
type StreamEvent = {
  streamId: string;
  kind: "progress" | "complete" | "error";
  data: unknown;
};
type StreamEventCallback = (event: StreamEvent) => void;
type IpcRequestId = string;

const listeners = new Map<string, Set<ListenCallback>>();
const streamListeners = new Map<string, StreamEventCallback>();

ipcRenderer.on("ipc:event", (_event, channelName: string, eventName: string, args: unknown) => {
  const key = `${channelName}:${eventName}`;
  const set = listeners.get(key);
  if (set) {
    for (const cb of set) {
      try {
        cb(args);
      } catch (err) {
        console.error(`[ipc:event listener threw] key=${key}`, err, "args=", args);
      }
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
    return ipcRenderer.invoke(
      "ipc:call",
      channelName,
      method,
      args,
      requestId ?? crypto.randomUUID(),
    );
  },

  cancel(requestId: IpcRequestId): void {
    ipcRenderer.send("ipc:cancel", requestId);
  },

  streamStart(channelName: string, method: string, args: unknown): Promise<IpcStreamStartResult> {
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

  listen(channelName: string, eventName: string, callback: ListenCallback): () => void {
    const key = `${channelName}:${eventName}`;
    let set = listeners.get(key);
    if (!set) {
      set = new Set();
      listeners.set(key, set);
    }
    set.add(callback);
    return () => {
      const current = listeners.get(key);
      if (!current) return;
      current.delete(callback);
      if (current.size === 0) listeners.delete(key);
    };
  },
};

contextBridge.exposeInMainWorld("ipc", ipcApi);

contextBridge.exposeInMainWorld("host", {
  platform: process.platform as NodeJS.Platform,
  windowsStore: process.windowsStore === true,
  transparentWindow: process.argv.includes(TRANSPARENT_WINDOW_ARG),
  opaqueWindow: process.argv.includes(OPAQUE_WINDOW_ARG),
});

contextBridge.exposeInMainWorld("files", {
  getPathForFile(file: File): string {
    const path = webUtils.getPathForFile(file);
    if (process.platform === "win32" && isNetworkOrDevicePath(path)) {
      ipcRenderer.send(REMEMBER_PICKED_FILE, path);
    }
    return path;
  },
  async readPickedAttachment(file: File): Promise<PickedAttachment | null> {
    if (process.platform !== "win32") return null;
    const path = webUtils.getPathForFile(file);
    return isWindowsLongPath(path) ? ipcRenderer.invoke(READ_PICKED_ATTACHMENT, path) : null;
  },
});
