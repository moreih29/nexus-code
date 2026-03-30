import log from 'electron-log/renderer'
import { IpcChannel } from '../shared/ipc'

const rlog = log.scope('renderer:ipc-bridge')
import type {
  TextChunkEvent,
  ToolCallEvent,
  ToolResultEvent,
  PermissionRequestEvent,
  SessionEndEvent,
  TurnEndEvent,
  PluginDataEvent,
  RestartAttemptEvent,
  RestartFailedEvent,
  TimeoutEvent,
  RateLimitEvent,
} from '../shared/types'
import { getStoreBySessionId, getActiveStore } from './stores/session-store'
import { usePermissionStore } from './stores/permission-store'
import { usePluginStore, useRightPanelUIStore } from './stores/plugin-store'
import { useStatusBarStore } from './stores/status-bar-store'
import type { TodoItem } from './stores/status-bar-store'
import { useChangesStore } from './stores/changes-store'

let initialized = false

export function initIpcBridge(): void {
  if (initialized) return
  initialized = true

  const permissionStore = usePermissionStore.getState
  const pluginStore = usePluginStore.getState
  const statusBarStore = useStatusBarStore.getState
  const changesStore = useChangesStore.getState

  // Stream events → session store
  window.electronAPI.on(IpcChannel.TEXT_CHUNK, ((event: TextChunkEvent) => {
    const store = getStoreBySessionId(event.sessionId) ?? getActiveStore()
    rlog.debug('TEXT_CHUNK len=%d store=%s', event.text.length, store ? 'found' : 'NULL')
    if (store) {
      store.getState().appendTextChunk(event.text)
    }
  }) as (...args: unknown[]) => void)

  window.electronAPI.on(IpcChannel.TOOL_CALL, ((event: ToolCallEvent) => {
    const store = getStoreBySessionId(event.sessionId) ?? getActiveStore()
    if (store) {
      store.getState().addToolCall(event)

      // auto-switch는 활성 세션일 때만
      const activeStore = getActiveStore()
      const isActive = store === activeStore

      if (event.name === 'Edit' || event.name === 'MultiEdit') {
        changesStore().trackChange({
          filePath: typeof event.input.file_path === 'string' ? event.input.file_path : '',
          toolName: event.name,
          toolUseId: event.toolUseId,
          timestamp: Date.now(),
          oldString: typeof event.input.old_string === 'string' ? event.input.old_string : undefined,
          newString: typeof event.input.new_string === 'string' ? event.input.new_string : undefined,
        })
        if (isActive) {
          useRightPanelUIStore.getState().requestAutoSwitch('changes')
        }
      } else if (event.name === 'Write') {
        changesStore().trackChange({
          filePath: typeof event.input.file_path === 'string' ? event.input.file_path : '',
          toolName: event.name,
          toolUseId: event.toolUseId,
          timestamp: Date.now(),
          content: typeof event.input.content === 'string' ? event.input.content : undefined,
        })
        if (isActive) {
          useRightPanelUIStore.getState().requestAutoSwitch('changes')
        }
      }

      if (event.name === 'TodoWrite') {
        const todos = event.input.todos as TodoItem[] | undefined
        if (Array.isArray(todos)) {
          statusBarStore().setTodos(todos)
        }
      }
      if (event.name === 'AskUserQuestion') {
        const questions = Array.isArray(event.input.questions)
          ? (event.input.questions as Array<{ question?: string; options?: unknown[] }>)
          : []
        const firstQ = questions[0]
        const question =
          typeof firstQ?.question === 'string'
            ? firstQ.question
            : typeof event.input.question === 'string'
              ? event.input.question
              : ''
        const rawOptions: unknown[] = firstQ?.options ?? []
        const options = rawOptions.map((o) =>
          typeof o === 'string' ? o : (o as Record<string, unknown>)?.label ? String((o as Record<string, unknown>).label) : JSON.stringify(o),
        )
        statusBarStore().setAskQuestion({ toolUseId: event.toolUseId, question, options })
      }
    }
  }) as (...args: unknown[]) => void)

  window.electronAPI.on(IpcChannel.TOOL_RESULT, ((event: ToolResultEvent) => {
    const store = getStoreBySessionId(event.sessionId) ?? getActiveStore()
    if (store) {
      store.getState().resolveToolCall(event.toolUseId, event.content, event.isError)
    }
    const current = statusBarStore().askQuestion
    if (current && current.toolUseId === event.toolUseId && !event.isError) {
      statusBarStore().setAskQuestion(null)
    }
  }) as (...args: unknown[]) => void)

  window.electronAPI.on(IpcChannel.TURN_END, ((event: TurnEndEvent) => {
    const store = getStoreBySessionId(event.sessionId) ?? getActiveStore()
    if (store) {
      const state = store.getState()
      const stats = {
        costUsd: event.costUsd,
        inputTokens: event.inputTokens,
        outputTokens: event.outputTokens,
        durationApiMs: event.durationApiMs,
        numTurns: event.numTurns,
      }
      state.flushStreamBuffer()
      state.setLastTurnStats(stats)
      state.addTurnToHistory(stats)
      state.endSession()
    }
  }) as (...args: unknown[]) => void)

  window.electronAPI.on(IpcChannel.SESSION_END, ((event: SessionEndEvent) => {
    const store = getStoreBySessionId(event.sessionId) ?? getActiveStore()
    if (store) {
      const state = store.getState()
      state.flushStreamBuffer()
      state.endSession()
    }
    statusBarStore().clearAll()
    changesStore().clear()
    pluginStore().clear()
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

  // Plugin events → plugin store + auto-switch
  window.electronAPI.on(IpcChannel.PLUGIN_DATA, ((event: PluginDataEvent) => {
    pluginStore().handlePluginData(event)

    if (event.pluginId === 'nexus') {
      if (event.panelId === 'timeline') {
        useRightPanelUIStore.getState().requestAutoSwitch('timeline')
      } else if (
        event.panelId === 'consult' ||
        event.panelId === 'decisions' ||
        event.panelId === 'tasks'
      ) {
        useRightPanelUIStore.getState().requestAutoSwitch('nexus')
      }
    }
  }) as (...args: unknown[]) => void)

  // Error recovery events → session store
  window.electronAPI.on(IpcChannel.RESTART_ATTEMPT, ((event: RestartAttemptEvent) => {
    rlog.info('restart_attempt', event)
    const store = getStoreBySessionId(event.sessionId) ?? getActiveStore()
    if (store) {
      store.getState().setStatus('restarting')
    }
  }) as (...args: unknown[]) => void)

  window.electronAPI.on(IpcChannel.RESTART_FAILED, ((event: RestartFailedEvent) => {
    rlog.warn('restart_failed')
    const store = getStoreBySessionId(event.sessionId) ?? getActiveStore()
    if (store) {
      store.getState().setStatus('error')
    }
  }) as (...args: unknown[]) => void)

  window.electronAPI.on(IpcChannel.TIMEOUT, ((event: TimeoutEvent) => {
    rlog.warn('timeout')
    const store = getStoreBySessionId(event.sessionId) ?? getActiveStore()
    if (store) {
      store.getState().setStatus('timeout')
    }
  }) as (...args: unknown[]) => void)

  window.electronAPI.on(IpcChannel.RATE_LIMIT, ((_event: RateLimitEvent) => {
    rlog.warn('rate_limit')
  }) as (...args: unknown[]) => void)
}
