import log from 'electron-log/renderer'
import { IpcChannel } from '../shared/ipc'
import type {
  TextChunkEvent,
  ToolCallEvent,
  ToolResultEvent,
  PermissionRequestEvent,
  SessionEndEvent,
  TurnEndEvent,
  PluginDataEvent,
} from '../shared/types'
import { useSessionStore } from './stores/session-store'
import { usePermissionStore } from './stores/permission-store'
import { usePluginStore } from './stores/plugin-store'

let initialized = false

export function initIpcBridge(): void {
  if (initialized) return
  initialized = true

  const sessionStore = useSessionStore.getState
  const permissionStore = usePermissionStore.getState
  const pluginStore = usePluginStore.getState

  // Stream events → session store
  window.electronAPI.on(IpcChannel.TEXT_CHUNK, ((event: TextChunkEvent) => {
    sessionStore().appendTextChunk(event.text)
  }) as (...args: unknown[]) => void)

  window.electronAPI.on(IpcChannel.TOOL_CALL, ((event: ToolCallEvent) => {
    sessionStore().addToolCall(event)
  }) as (...args: unknown[]) => void)

  window.electronAPI.on(IpcChannel.TOOL_RESULT, ((event: ToolResultEvent) => {
    sessionStore().resolveToolCall(event.toolUseId, event.content, event.isError)
  }) as (...args: unknown[]) => void)

  window.electronAPI.on(IpcChannel.TURN_END, ((_event: TurnEndEvent) => {
    sessionStore().flushStreamBuffer()
    sessionStore().endSession()
  }) as (...args: unknown[]) => void)

  window.electronAPI.on(IpcChannel.SESSION_END, ((_event: SessionEndEvent) => {
    sessionStore().flushStreamBuffer()
    sessionStore().endSession()
  }) as (...args: unknown[]) => void)

  // Permission events → permission store
  window.electronAPI.on(IpcChannel.PERMISSION_REQUEST, ((event: PermissionRequestEvent) => {
    permissionStore().add({
      requestId: event.requestId,
      toolName: event.toolName,
      input: event.input,
      agentId: event.agentId,
      timestamp: Date.now(),
    })
  }) as (...args: unknown[]) => void)

  // Plugin events → plugin store
  window.electronAPI.on(IpcChannel.PLUGIN_DATA, ((event: PluginDataEvent) => {
    pluginStore().handlePluginData(event)
  }) as (...args: unknown[]) => void)
}
