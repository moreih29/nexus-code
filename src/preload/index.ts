import { contextBridge, ipcRenderer } from 'electron'
import type { ElectronAPI } from '../shared/types'

const api: ElectronAPI = {
  invoke<T = unknown>(channel: string, ...args: unknown[]): Promise<T> {
    return ipcRenderer.invoke(channel, ...args)
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
