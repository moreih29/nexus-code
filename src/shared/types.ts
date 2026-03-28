// IPC channel types shared between main and renderer processes

// ─── Request-Response Channels ───────────────────────────────────────────────

export interface StartRequest {
  prompt: string
  cwd: string
  permissionMode: 'auto' | 'manual'
  sessionId?: string  // 후속 메시지 시 --resume에 사용
  model?: string
  notificationsEnabled?: boolean
  images?: ImageAttachment[]
}

export interface StartResponse {
  sessionId: string
  checkpoint?: Checkpoint
}

export interface ImageAttachment {
  mediaType: string
  data: string
}

export interface PromptRequest {
  sessionId: string
  message: string
  images?: ImageAttachment[]
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
  notificationsEnabled?: boolean
}

export interface LoadSessionResponse {
  ok: boolean
}

export type ApprovalScope = 'once' | 'session' | 'permanent'

export interface ApprovalRule {
  toolName: string
  scope: 'session' | 'permanent'
}

export interface RespondPermissionRequest {
  requestId: string
  approved: boolean
  scope?: ApprovalScope
}

export interface RespondPermissionResponse {
  ok: boolean
}

export interface StatusRequest {
  sessionId: string
}

export type SessionStatus = 'idle' | 'running' | 'waiting_permission' | 'ended' | 'error' | 'restarting' | 'timeout'

export interface RestartAttemptEvent {
  sessionId: string
  attempt: number
  maxAttempts: number
  reason: string
}

export interface RestartFailedEvent {
  sessionId: string
  reason: string
}

export interface TimeoutEvent {
  sessionId: string
  timeoutMs: number
}

export interface RateLimitEvent {
  sessionId: string
  retryAfterMs?: number
}

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

export interface TurnEndEvent {
  sessionId: string
  costUsd?: number
  durationMs?: number
  inputTokens?: number
  outputTokens?: number
  durationApiMs?: number
  numTurns?: number
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
  sessionId?: string
}

export interface WorkspaceUpdateSessionRequest {
  path: string
  sessionId: string
}

export interface WorkspaceUpdateSessionResponse {
  ok: boolean
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
  parentAgentId?: string
  agentType?: string
  events: AgentToolEvent[]
  lastSeen: number
  startedAt?: number
  stoppedAt?: number
  status?: 'idle' | 'running' | 'error' | 'stopped'
}

export interface AgentTimelineData {
  agents: AgentNode[]
}

// ─── Settings ────────────────────────────────────────────────────────────────

export interface ClaudeSettings {
  permissions?: {
    allow?: string[]
    deny?: string[]
    defaultMode?: string
  }
  enabledPlugins?: Record<string, boolean>
  env?: Record<string, string>
  language?: string
  effortLevel?: string
  autoMemoryEnabled?: boolean
  skipDangerousModePermissionPrompt?: boolean
  teammateMode?: string
  statusLine?: unknown
  extraKnownMarketplaces?: unknown
  [key: string]: unknown
}

export interface ReadSettingsResponse {
  global: ClaudeSettings
  project: ClaudeSettings
}

export interface WriteSettingsRequest {
  scope: 'global' | 'project'
  settings: ClaudeSettings
}

export interface WriteSettingsResponse {
  ok: boolean
}

// ─── History ─────────────────────────────────────────────────────────────────

export interface LoadHistoryRequest {
  sessionId: string
}

export interface HistoryMessage {
  role: 'user' | 'assistant'
  content: string
  toolCalls?: Array<{
    toolUseId: string
    name: string
    input: Record<string, unknown>
    result?: string
    isError?: boolean
  }>
  timestamp: number
}

export interface LoadHistoryResponse {
  ok: boolean
  messages: HistoryMessage[]
}

// ─── Git ─────────────────────────────────────────────────────────────────────

export interface GitCheckRequest {
  cwd: string
}

export interface GitCheckResponse {
  isGitRepo: boolean
}

export interface GitInitRequest {
  cwd: string
}

export interface GitInitResponse {
  ok: boolean
}

// ─── Checkpoint ──────────────────────────────────────────────────────────────

export interface Checkpoint {
  stashRef?: string
  headHash: string
  sessionId: string
  timestamp: number
}

export interface CheckpointCreateRequest {
  cwd: string
  sessionId: string
}

export interface CheckpointCreateResponse {
  ok: boolean
  checkpoint?: Checkpoint
  isGitRepo: boolean
}

export interface CheckpointRestoreRequest {
  cwd: string
  checkpoint: Checkpoint
}

export interface CheckpointRestoreResponse {
  ok: boolean
  error?: string
  changedFiles?: string[]
  shortHash?: string
}

export interface CheckpointListRequest {
  cwd: string
  sessionId?: string
}

export interface CheckpointListResponse {
  ok: boolean
  checkpoints: Checkpoint[]
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
