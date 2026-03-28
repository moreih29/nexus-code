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
  RestartAttemptEvent,
  RestartFailedEvent,
  TimeoutEvent,
  RateLimitEvent,
} from '../shared/types'
import { useSessionStore } from './stores/session-store'
import { usePermissionStore } from './stores/permission-store'
import { usePluginStore } from './stores/plugin-store'
import { useStatusBarStore } from './stores/status-bar-store'
import type { TodoItem } from './stores/status-bar-store'
import { useChangesStore } from './stores/changes-store'

let initialized = false

export function initIpcBridge(): void {
  if (initialized) return
  initialized = true

  const sessionStore = useSessionStore.getState
  const permissionStore = usePermissionStore.getState
  const pluginStore = usePluginStore.getState
  const statusBarStore = useStatusBarStore.getState
  const changesStore = useChangesStore.getState

  /** sessionId로 tabId를 조회 — 없으면 activeTabId로 폴백 */
  const resolveTabId = (sessionId: string): string | null => {
    const state = sessionStore()
    const tabId = state.sessionTabMap[sessionId]
    if (tabId) return tabId
    return state.activeTabId
  }

  // Stream events → session store (탭별 라우팅)
  window.electronAPI.on(IpcChannel.TEXT_CHUNK, ((event: TextChunkEvent) => {
    const tabId = resolveTabId(event.sessionId)
    if (!tabId) return
    sessionStore().appendTextChunkToTab(tabId, event.text)
  }) as (...args: unknown[]) => void)

  window.electronAPI.on(IpcChannel.TOOL_CALL, ((event: ToolCallEvent) => {
    const tabId = resolveTabId(event.sessionId)
    if (!tabId) return
    sessionStore().addToolCallToTab(tabId, event)

    if (event.name === 'Edit' || event.name === 'MultiEdit') {
      changesStore().trackChange({
        filePath: typeof event.input.file_path === 'string' ? event.input.file_path : '',
        toolName: event.name,
        toolUseId: event.toolUseId,
        timestamp: Date.now(),
        oldString: typeof event.input.old_string === 'string' ? event.input.old_string : undefined,
        newString: typeof event.input.new_string === 'string' ? event.input.new_string : undefined,
      })
    } else if (event.name === 'Write') {
      changesStore().trackChange({
        filePath: typeof event.input.file_path === 'string' ? event.input.file_path : '',
        toolName: event.name,
        toolUseId: event.toolUseId,
        timestamp: Date.now(),
        content: typeof event.input.content === 'string' ? event.input.content : undefined,
      })
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
  }) as (...args: unknown[]) => void)

  window.electronAPI.on(IpcChannel.TOOL_RESULT, ((event: ToolResultEvent) => {
    const tabId = resolveTabId(event.sessionId)
    if (!tabId) return
    sessionStore().resolveToolCallInTab(tabId, event.toolUseId, event.content, event.isError)
    const current = statusBarStore().askQuestion
    if (current && current.toolUseId === event.toolUseId && !event.isError) {
      statusBarStore().setAskQuestion(null)
    }
  }) as (...args: unknown[]) => void)

  window.electronAPI.on(IpcChannel.TURN_END, ((event: TurnEndEvent) => {
    const tabId = resolveTabId(event.sessionId)
    if (!tabId) return

    sessionStore().flushStreamBufferInTab(tabId)
    sessionStore().setLastTurnStatsInTab(tabId, {
      costUsd: event.costUsd,
      inputTokens: event.inputTokens,
      outputTokens: event.outputTokens,
      durationApiMs: event.durationApiMs,
      numTurns: event.numTurns,
    })
    sessionStore().endSessionInTab(tabId)
  }) as (...args: unknown[]) => void)

  window.electronAPI.on(IpcChannel.SESSION_END, ((event: SessionEndEvent) => {
    const tabId = resolveTabId(event.sessionId)
    if (!tabId) return
    sessionStore().flushStreamBufferInTab(tabId)
    sessionStore().endSessionInTab(tabId)
    statusBarStore().clearAll()
    changesStore().clear()
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

  // Error recovery events → session store
  window.electronAPI.on(IpcChannel.RESTART_ATTEMPT, ((event: RestartAttemptEvent) => {
    log.info('[ipc-bridge] restart_attempt', event)
    const tabId = resolveTabId(event.sessionId)
    if (!tabId) return
    sessionStore().setStatusInTab(tabId, 'restarting')
  }) as (...args: unknown[]) => void)

  window.electronAPI.on(IpcChannel.RESTART_FAILED, ((event: RestartFailedEvent) => {
    log.warn('[ipc-bridge] restart_failed')
    const tabId = resolveTabId(event.sessionId)
    if (!tabId) return
    sessionStore().setStatusInTab(tabId, 'error')
  }) as (...args: unknown[]) => void)

  window.electronAPI.on(IpcChannel.TIMEOUT, ((event: TimeoutEvent) => {
    log.warn('[ipc-bridge] timeout')
    const tabId = resolveTabId(event.sessionId)
    if (!tabId) return
    sessionStore().setStatusInTab(tabId, 'timeout')
  }) as (...args: unknown[]) => void)

  window.electronAPI.on(IpcChannel.RATE_LIMIT, ((_event: RateLimitEvent) => {
    log.warn('[ipc-bridge] rate_limit')
  }) as (...args: unknown[]) => void)
}
