// IPC channel name constants — used by both main and renderer processes

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

  // ── History ───────────────────────────────────────────────────────────────
  /** Load conversation history for a session from its JSONL file */
  LOAD_HISTORY: 'ipc:load-history',

  // ── PluginHost ────────────────────────────────────────────────────────────
  /** Plugin data update pushed from main to a renderer panel */
  PLUGIN_DATA: 'plugin:data',

  // ── Error Recovery ────────────────────────────────────────────────────────
  /** CLI process is being restarted after crash */
  RESTART_ATTEMPT: 'stream:restart-attempt',
  /** CLI process restart has exhausted all retries */
  RESTART_FAILED: 'stream:restart-failed',

  // ── Timeout ───────────────────────────────────────────────────────────────
  /** No activity from CLI for ACTIVITY_TIMEOUT_MS */
  TIMEOUT: 'stream:timeout',
  /** CLI is rate-limited and will auto-retry */
  RATE_LIMIT: 'stream:rate-limit',
} as const

export type IpcChannelName = (typeof IpcChannel)[keyof typeof IpcChannel]
