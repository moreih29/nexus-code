// IPC channel types shared between main and renderer processes

// ─── Request-Response Channels ───────────────────────────────────────────────

export interface StartRequest {
  prompt: string
  cwd: string
  permissionMode: 'auto' | 'manual'
}

export interface StartResponse {
  sessionId: string
}

export interface PromptRequest {
  sessionId: string
  message: string
}

export interface PromptResponse {
  ok: boolean
}

export interface CancelRequest {
  sessionId: string
}

export interface CancelResponse {
  ok: boolean
}

export interface ListSessionsRequest {
  // no params — lists all sessions from ~/.claude/
}

export interface SessionInfo {
  id: string
  createdAt: string
  cwd: string
  preview?: string
}

export interface ListSessionsResponse {
  sessions: SessionInfo[]
}

export interface LoadSessionRequest {
  sessionId: string
}

export interface LoadSessionResponse {
  ok: boolean
}

export interface RespondPermissionRequest {
  requestId: string
  approved: boolean
}

export interface RespondPermissionResponse {
  ok: boolean
}

export interface StatusRequest {
  sessionId: string
}

export type SessionStatus = 'idle' | 'running' | 'waiting_permission' | 'ended' | 'error'

export interface StatusResponse {
  status: SessionStatus
  sessionId: string
}

// ─── Stream Events (Main → Renderer) ────────────────────────────────────────

export interface TextChunkEvent {
  sessionId: string
  text: string
  agentId?: string
}

export interface ToolCallEvent {
  sessionId: string
  toolUseId: string
  name: string
  input: Record<string, unknown>
  agentId?: string
}

export interface ToolResultEvent {
  sessionId: string
  toolUseId: string
  content: string
  isError?: boolean
  agentId?: string
}

export interface PermissionRequestEvent {
  sessionId: string
  requestId: string
  toolName: string
  input: Record<string, unknown>
  agentId?: string
}

export interface SessionEndEvent {
  sessionId: string
  exitCode?: number
}

export interface ErrorEvent {
  sessionId: string
  message: string
  code?: string
}

// ─── Workspace ───────────────────────────────────────────────────────────────

export interface WorkspaceEntry {
  path: string
  name: string
}

export interface WorkspaceListResponse {
  workspaces: WorkspaceEntry[]
}

export interface WorkspaceAddResponse {
  workspace: WorkspaceEntry | null
  cancelled: boolean
}

export interface WorkspaceRemoveRequest {
  path: string
}

export interface WorkspaceRemoveResponse {
  ok: boolean
}

// ─── PluginHost Events ───────────────────────────────────────────────────────

export interface PluginDataEvent {
  pluginId: string
  panelId: string
  data: unknown
}

// ─── AgentTracker Types ──────────────────────────────────────────────────────

export interface AgentToolEvent {
  toolUseId: string
  toolName: string
  input: Record<string, unknown>
  timestamp: number
  result?: string
  isError?: boolean
  durationMs?: number
}

export interface AgentNode {
  agentId: string
  events: AgentToolEvent[]
  lastSeen: number
}

export interface AgentTimelineData {
  agents: AgentNode[]
}

// ─── Window augmentation ────────────────────────────────────────────────────

export interface ElectronAPI {
  invoke<T = unknown>(channel: string, ...args: unknown[]): Promise<T>
  on(channel: string, callback: (...args: unknown[]) => void): void
  off(channel: string, callback: (...args: unknown[]) => void): void
}

declare global {
  interface Window {
    electronAPI: ElectronAPI
  }
}
