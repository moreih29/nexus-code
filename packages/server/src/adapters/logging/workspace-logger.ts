import { appendFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'

interface LogEntry {
  ts: string
  type: string
  sessionId?: string
  data: unknown
}

const isDev = process.env['NODE_ENV'] !== 'production'

export class WorkspaceLogger {
  private readonly active: boolean

  constructor() {
    this.active = isDev
  }

  log(workspacePath: string, entry: Omit<LogEntry, 'ts'>): void {
    if (!this.active) return

    const full: LogEntry = { ts: new Date().toISOString(), ...entry }
    const date = full.ts.slice(0, 10)
    const dir = join(workspacePath, '.nexus', 'logs')
    const file = join(dir, `${date}.jsonl`)

    mkdir(dir, { recursive: true })
      .then(() => appendFile(file, JSON.stringify(full) + '\n'))
      .catch(() => {
        // fire-and-forget — logging failures must not surface to callers
      })
  }
}
