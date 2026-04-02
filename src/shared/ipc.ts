// IPC channel name constants — used by both main and renderer processes
import type {
  StartRequest, StartResponse,
  PromptRequest, PromptResponse,
  CancelRequest, CancelResponse,
  ListSessionsResponse,
  LoadSessionRequest, LoadSessionResponse,
  RespondPermissionRequest, RespondPermissionResponse,
  StatusRequest, StatusResponse,
  WorkspaceListResponse,
  WorkspaceAddResponse,
  WorkspaceRemoveRequest, WorkspaceRemoveResponse,
  WorkspaceUpdateSessionRequest, WorkspaceUpdateSessionResponse,
  ReadSettingsRequest, ReadSettingsResponse,
  WriteSettingsRequest, WriteSettingsResponse,
  DeleteSettingsKeyRequest, DeleteSettingsKeyResponse,
  SettingsSyncRequest,
  ReadFileRequest, ReadFileResponse,
  LoadHistoryRequest, LoadHistoryResponse,
  CheckpointCreateRequest, CheckpointCreateResponse,
  CheckpointRestoreRequest, CheckpointRestoreResponse,
  CheckpointListRequest, CheckpointListResponse,
  CheckpointDiffRequest, CheckpointDiffResponse,
  GitCheckRequest, GitCheckResponse,
  GitInitRequest, GitInitResponse,
  NexusStateReadRequest, NexusStateReadResponse,
  RestartSessionRequest, RestartSessionResponse,
} from './types'

export const IpcChannel = {
  // ── Request-Response ──────────────────────────────────────────────────────
  /** Start a new Claude session */
  START: 'ipc:start',
  /** Send a follow-up prompt to an active session */
  PROMPT: 'ipc:prompt',
  /** Cancel an active session */
  CANCEL: 'ipc:cancel',
  /** List saved sessions from ~/.claude/ */
  LIST_SESSIONS: 'ipc:list-sessions',
  /** Resume a saved session (--resume) */
  LOAD_SESSION: 'ipc:load-session',
  /** Approve or deny a permission request */
  RESPOND_PERMISSION: 'ipc:respond-permission',
  /** Query the current session status */
  STATUS: 'ipc:status',

  // ── Stream Events (Main → Renderer) ──────────────────────────────────────
  /** Streamed text chunk from Claude */
  TEXT_CHUNK: 'stream:text-chunk',
  /** A tool invocation event */
  TOOL_CALL: 'stream:tool-call',
  /** Result of a tool execution */
  TOOL_RESULT: 'stream:tool-result',
  /** Claude is requesting user permission for a tool */
  PERMISSION_REQUEST: 'stream:permission-request',
  /** Session has finished */
  SESSION_END: 'stream:session-end',
  /** A single turn (response) has completed; process stays alive */
  TURN_END: 'stream:turn-end',
  /** An error occurred in the session */
  ERROR: 'stream:error',

  // ── Workspace ─────────────────────────────────────────────────────────────
  /** List all registered workspaces */
  WORKSPACE_LIST: 'ipc:workspace-list',
  /** Add a workspace (opens native folder picker) */
  WORKSPACE_ADD: 'ipc:workspace-add',
  /** Remove a workspace by path */
  WORKSPACE_REMOVE: 'ipc:workspace-remove',
  /** Update the sessionId stored for a workspace */
  WORKSPACE_UPDATE_SESSION: 'ipc:workspace-update-session',

  // ── Settings ──────────────────────────────────────────────────────────────
  /** Read global and project settings.json */
  SETTINGS_READ: 'ipc:settings-read',
  /** Write to global or project settings.json */
  SETTINGS_WRITE: 'ipc:settings-write',
  /** Delete a single key from global or project settings.json */
  SETTINGS_DELETE_KEY: 'ipc:settings-delete-key',
  /** Sync in-app settings (e.g. notificationsEnabled) to main process */
  SETTINGS_SYNC: 'ipc:settings-sync',

  // ── History ───────────────────────────────────────────────────────────────
  /** Load conversation history for a session from its JSONL file */
  LOAD_HISTORY: 'ipc:load-history',

  // ── PluginHost ────────────────────────────────────────────────────────────
  /** Plugin data update pushed from main to a renderer panel */
  PLUGIN_DATA: 'plugin:data',

  // ── Checkpoint ────────────────────────────────────────────────────────────
  /** Create a git stash-based checkpoint for a session */
  CHECKPOINT_CREATE: 'ipc:checkpoint-create',
  /** Restore working tree to a previously created checkpoint */
  CHECKPOINT_RESTORE: 'ipc:checkpoint-restore',
  /** List checkpoints for the current workspace */
  CHECKPOINT_LIST: 'ipc:checkpoint-list',
  /** Get diff between two checkpoints or checkpoint vs working tree */
  CHECKPOINT_DIFF: 'ipc:checkpoint-diff',

  // ── Git ───────────────────────────────────────────────────────────────────
  /** Check whether a directory is a git repository */
  GIT_CHECK: 'ipc:git-check',
  /** Initialize a git repository in the given directory */
  GIT_INIT: 'ipc:git-init',

  // ── Error Recovery ────────────────────────────────────────────────────────
  /** CLI process is being restarted after crash */
  RESTART_ATTEMPT: 'stream:restart-attempt',
  /** CLI process restart has exhausted all retries */
  RESTART_FAILED: 'stream:restart-failed',

  // ── Nexus State ────────────────────────────────────────────────────────
  /** Read .nexus/state/*.json from a workspace (PluginHost 독립) */
  NEXUS_STATE_READ: 'ipc:nexus-state-read',
  /** .nexus/state/ 파일 변경 시 Renderer에 알림 */
  NEXUS_STATE_CHANGED: 'stream:nexus-state-changed',

  // ── Restart Session ───────────────────────────────────────────────────────
  /** Kill existing session and restart with --resume + new flags */
  RESTART_SESSION: 'ipc:restart-session',

  // ── File ──────────────────────────────────────────────────────────────────
  /** Read a file by path (MarkdownViewer용, .md 파일만 허용) */
  READ_FILE: 'ipc:read-file',

  // ── Timeout ───────────────────────────────────────────────────────────────
  /** No activity from CLI for ACTIVITY_TIMEOUT_MS */
  TIMEOUT: 'stream:timeout',
  /** CLI is rate-limited and will auto-retry */
  RATE_LIMIT: 'stream:rate-limit',

  // ── Session Status ─────────────────────────────────────────────────────────
  /** 세션 상태 변경 이벤트 (suspended 포함) — Main → Renderer */
  STATUS_CHANGE: 'stream:status-change',
} as const

export type IpcChannelName = (typeof IpcChannel)[keyof typeof IpcChannel]

export type IpcMap = {
  [IpcChannel.START]: { req: StartRequest; res: StartResponse }
  [IpcChannel.PROMPT]: { req: PromptRequest; res: PromptResponse }
  [IpcChannel.CANCEL]: { req: CancelRequest; res: CancelResponse }
  [IpcChannel.LIST_SESSIONS]: { req: void; res: ListSessionsResponse }
  [IpcChannel.LOAD_SESSION]: { req: LoadSessionRequest; res: LoadSessionResponse }
  [IpcChannel.RESPOND_PERMISSION]: { req: RespondPermissionRequest; res: RespondPermissionResponse }
  [IpcChannel.STATUS]: { req: StatusRequest; res: StatusResponse }
  [IpcChannel.WORKSPACE_LIST]: { req: void; res: WorkspaceListResponse }
  [IpcChannel.WORKSPACE_ADD]: { req: void; res: WorkspaceAddResponse }
  [IpcChannel.WORKSPACE_REMOVE]: { req: WorkspaceRemoveRequest; res: WorkspaceRemoveResponse }
  [IpcChannel.WORKSPACE_UPDATE_SESSION]: { req: WorkspaceUpdateSessionRequest; res: WorkspaceUpdateSessionResponse }
  [IpcChannel.SETTINGS_READ]: { req: ReadSettingsRequest; res: ReadSettingsResponse }
  [IpcChannel.SETTINGS_WRITE]: { req: WriteSettingsRequest; res: WriteSettingsResponse }
  [IpcChannel.SETTINGS_DELETE_KEY]: { req: DeleteSettingsKeyRequest; res: DeleteSettingsKeyResponse }
  [IpcChannel.SETTINGS_SYNC]: { req: SettingsSyncRequest; res: void }
  [IpcChannel.READ_FILE]: { req: ReadFileRequest; res: ReadFileResponse }
  [IpcChannel.LOAD_HISTORY]: { req: LoadHistoryRequest; res: LoadHistoryResponse }
  [IpcChannel.CHECKPOINT_CREATE]: { req: CheckpointCreateRequest; res: CheckpointCreateResponse }
  [IpcChannel.CHECKPOINT_RESTORE]: { req: CheckpointRestoreRequest; res: CheckpointRestoreResponse }
  [IpcChannel.CHECKPOINT_LIST]: { req: CheckpointListRequest; res: CheckpointListResponse }
  [IpcChannel.CHECKPOINT_DIFF]: { req: CheckpointDiffRequest; res: CheckpointDiffResponse }
  [IpcChannel.GIT_CHECK]: { req: GitCheckRequest; res: GitCheckResponse }
  [IpcChannel.GIT_INIT]: { req: GitInitRequest; res: GitInitResponse }
  [IpcChannel.NEXUS_STATE_READ]: { req: NexusStateReadRequest; res: NexusStateReadResponse }
  [IpcChannel.RESTART_SESSION]: { req: RestartSessionRequest; res: RestartSessionResponse }
}

export interface ElectronAPI {
  invoke<C extends keyof IpcMap>(
    channel: C,
    ...args: IpcMap[C]['req'] extends void ? [] : [req: IpcMap[C]['req']]
  ): Promise<IpcMap[C]['res']>

  on(channel: string, callback: (...args: unknown[]) => void): void
  off(channel: string, callback: (...args: unknown[]) => void): void
}
