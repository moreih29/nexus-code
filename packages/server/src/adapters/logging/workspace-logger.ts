import { appendFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { workspacePathToId } from '../../utils/workspace-id.js'

export type LogEntryType =
  | 'session_start'
  | 'session_cancel'
  | 'session_restart'
  | 'session_resume'
  | 'session_prompt'
  | 'hook_request'
  | 'hook_response'
  | 'approval_request'
  | 'approval_response'
  | 'sse_connect'
  | 'sse_disconnect'
  | 'sse_event'
  | 'protected_path_detected'
  | 'web_client'

export interface LogEntry {
  ts: string
  type: LogEntryType
  sessionId?: string
  requestId?: string
  workspaceId?: string
  data: unknown
}

export class WorkspaceLogger {
  private readonly active: boolean
  private readonly baseDir: string

  constructor() {
    this.active = process.env['NODE_ENV'] !== 'production'
    this.baseDir = process.env['NEXUS_LOG_DIR'] ?? join(homedir(), '.nexus-code', 'logs')
  }

  log(workspacePath: string, entry: Omit<LogEntry, 'ts' | 'workspaceId'>): void {
    if (!this.active) return

    const workspaceId = workspacePathToId(workspacePath)
    const full: LogEntry = {
      ts: new Date().toISOString(),
      workspaceId,
      ...entry,
    }
    const date = full.ts.slice(0, 10)
    const dir = join(this.baseDir, workspaceId)
    const file = join(dir, `${date}.jsonl`)

    mkdir(dir, { recursive: true })
      .then(() => appendFile(file, JSON.stringify(full) + '\n'))
      .catch(() => {
        // fire-and-forget — logging failures must not surface to callers
      })
  }
}
