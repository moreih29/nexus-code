import { contextBridge, ipcRenderer } from "electron";

type ListenCallback = (args: unknown) => void;

// key: `${channel}:${event}` → Set of callbacks
const listeners = new Map<string, Set<ListenCallback>>();

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

const ipcApi = {
  call(channelName: string, method: string, args: unknown): Promise<unknown> {
    return ipcRenderer.invoke("ipc:call", channelName, method, args);
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
