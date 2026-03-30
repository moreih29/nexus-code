import { contextBridge, ipcRenderer } from 'electron'
import { IpcChannel } from '../shared/ipc'
import type { IpcMap, ElectronAPI } from '../shared/ipc'

const ALLOWED_CHANNELS = new Set<string>(Object.values(IpcChannel))

const api: ElectronAPI = {
  invoke<C extends keyof IpcMap>(
    channel: C,
    ...args: IpcMap[C]['req'] extends void ? [] : [req: IpcMap[C]['req']]
  ): Promise<IpcMap[C]['res']> {
    if (!ALLOWED_CHANNELS.has(channel as string)) {
      return Promise.reject(new Error(`Blocked IPC channel: ${channel}`))
    }
    return ipcRenderer.invoke(channel, ...args) as Promise<IpcMap[C]['res']>
  },

  on(channel: string, callback: (...args: unknown[]) => void): void {
    const listener = (_event: Electron.IpcRendererEvent, ...args: unknown[]): void =>
      callback(...args)
    ipcRenderer.on(channel, listener)
    // Store the mapped listener so off() can remove the exact same reference.
    listenerMap.set(callback, listener)
  },

  off(channel: string, callback: (...args: unknown[]) => void): void {
    const listener = listenerMap.get(callback)
    if (listener) {
      ipcRenderer.off(channel, listener)
      listenerMap.delete(callback)
    }
  },
}

// Map from caller-supplied callbacks to the wrapped ipcRenderer listeners.
const listenerMap = new WeakMap<
  (...args: unknown[]) => void,
  (event: Electron.IpcRendererEvent, ...args: unknown[]) => void
>()

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electronAPI', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electronAPI = api
}
