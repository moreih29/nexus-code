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
  /** An error occurred in the session */
  ERROR: 'stream:error',

  // ── Workspace ─────────────────────────────────────────────────────────────
  /** List all registered workspaces */
  WORKSPACE_LIST: 'ipc:workspace-list',
  /** Add a workspace (opens native folder picker) */
  WORKSPACE_ADD: 'ipc:workspace-add',
  /** Remove a workspace by path */
  WORKSPACE_REMOVE: 'ipc:workspace-remove',

  // ── PluginHost ────────────────────────────────────────────────────────────
  /** Plugin data update pushed from main to a renderer panel */
  PLUGIN_DATA: 'plugin:data',
} as const

export type IpcChannelName = (typeof IpcChannel)[keyof typeof IpcChannel]
