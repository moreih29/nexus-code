// IPC channel types shared between main and renderer processes

// ─── Request-Response Channels ───────────────────────────────────────────────

export interface StartRequest {
  prompt: string
  cwd: string
  permissionMode: 'auto' | 'default'
  sessionId?: string  // 후속 메시지 시 --resume에 사용
  model?: string
  effortLevel?: string
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
  cwd?: string
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

// ─── Nexus State ────────────────────────────────────────────────────────

export interface NexusStateReadRequest {
  cwd: string
}

export interface NexusStateReadResponse {
  consult: unknown
  decisions: unknown
  tasks: unknown
}

export interface NexusStateChangedEvent {
  cwd: string
  consult: unknown
  decisions: unknown
  tasks: unknown
}

// ─── PluginHost Events ───────────────────────────────────────────────────────

export interface PluginDataEvent {
  pluginId: string
  panelId: string
  data: unknown
  sessionId?: string
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
  model?: string
  permissions?: {
    allow?: string[]
    deny?: string[]
    defaultMode?: string
  }
  enabledPlugins?: Record<string, boolean>
  env?: Record<string, string>
  language?: string
  effortLevel?: 'low' | 'medium' | 'high' | 'max' | 'auto'
  autoMemoryEnabled?: boolean
  skipDangerousModePermissionPrompt?: boolean
  teammateMode?: 'auto' | 'in-process' | 'tmux'
  statusLine?: unknown
  extraKnownMarketplaces?: unknown
  outputStyle?: string
  sandbox?: { enabled?: boolean }
  defaultShell?: string
  prefersReducedMotion?: boolean
  includeGitInstructions?: boolean
  cleanupPeriodDays?: number
  alwaysThinkingEnabled?: boolean
  [key: string]: unknown
}

export interface ReadSettingsRequest {
  workspacePath?: string
}

export interface ReadSettingsResponse {
  global: ClaudeSettings
  project: ClaudeSettings
}

export interface WriteSettingsRequest {
  scope: 'global' | 'project'
  settings: ClaudeSettings
  workspacePath?: string
}

export interface WriteSettingsResponse {
  ok: boolean
}

export interface DeleteSettingsKeyRequest {
  scope: 'global' | 'project'
  key: string
  workspacePath?: string
}

export interface DeleteSettingsKeyResponse {
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
  /** git stash create로 생성된 commit object hash. 빈 문자열이면 클린 트리 */
  hash: string
  headHash: string
  sessionId: string
  timestamp: number
  /** 체크포인트와 연결된 메시지 ID */
  messageId?: string
}

export interface CheckpointCreateRequest {
  cwd: string
  sessionId: string
  messageId?: string
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
  untrackedFiles?: string[]
}

export interface CheckpointListRequest {
  cwd: string
  sessionId?: string
}

export interface CheckpointListResponse {
  ok: boolean
  checkpoints: Checkpoint[]
}

// ─── Settings Sync ───────────────────────────────────────────────────────────

export interface SettingsSyncRequest {
  notificationsEnabled: boolean
}

// ─── File ────────────────────────────────────────────────────────────────────

export interface ReadFileRequest {
  path: string
  workspacePath: string
}

export interface ReadFileResponse {
  ok: boolean
  content?: string
  error?: string
}

// ─── Window augmentation ────────────────────────────────────────────────────
// ElectronAPI is defined in ipc.ts to avoid circular imports (ipc.ts → types.ts → ipc.ts).
// Re-exported here for backwards compatibility.
export type { ElectronAPI } from './ipc'

declare global {
  interface Window {
    // Import from ipc.ts at callsite — kept here only for Window augmentation reference
    electronAPI: import('./ipc').ElectronAPI
  }
}
