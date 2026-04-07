import Database from 'better-sqlite3'

export interface SessionRow {
  id: string
  cli_session_id: string | null
  workspace_path: string
  agent_id: string
  status: string
  model: string | null
  permission_mode: string | null
  prompt: string | null
  created_at: string
  ended_at: string | null
  error_message: string | null
  exit_code: number | null
}

export class SessionStore {
  readonly db: Database.Database

  constructor(dbPath: string) {
    this.db = new Database(dbPath)
    this.db.pragma('journal_mode = WAL')
    this.migrate()
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        cli_session_id TEXT,
        workspace_path TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'idle',
        model TEXT,
        permission_mode TEXT,
        prompt TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        ended_at TEXT,
        error_message TEXT,
        exit_code INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_workspace ON sessions(workspace_path);
      CREATE INDEX IF NOT EXISTS idx_sessions_created ON sessions(created_at DESC);
    `)
  }

  create(session: {
    id: string
    workspacePath: string
    agentId: string
    status?: string
    model?: string
    permissionMode?: string
    prompt?: string
  }): SessionRow {
    const stmt = this.db.prepare<
      [string, string, string, string, string | null, string | null, string | null],
      SessionRow
    >(`
      INSERT INTO sessions (id, workspace_path, agent_id, status, model, permission_mode, prompt)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      RETURNING *
    `)
    return stmt.get(
      session.id,
      session.workspacePath,
      session.agentId,
      session.status ?? 'idle',
      session.model ?? null,
      session.permissionMode ?? null,
      session.prompt ?? null,
    )!
  }

  updateCliSessionId(id: string, cliSessionId: string): void {
    this.db
      .prepare('UPDATE sessions SET cli_session_id = ? WHERE id = ?')
      .run(cliSessionId, id)
  }

  updateStatus(id: string, status: string): void {
    this.db.prepare('UPDATE sessions SET status = ? WHERE id = ?').run(status, id)
  }

  updateSettings(id: string, settings: { model?: string; permissionMode?: string }): void {
    const parts: string[] = []
    const values: unknown[] = []

    if (settings.model !== undefined) {
      parts.push('model = ?')
      values.push(settings.model)
    }
    if (settings.permissionMode !== undefined) {
      parts.push('permission_mode = ?')
      values.push(settings.permissionMode)
    }

    if (parts.length === 0) return

    values.push(id)
    this.db.prepare(`UPDATE sessions SET ${parts.join(', ')} WHERE id = ?`).run(...values)
  }

  markEnded(id: string, exitCode: number | null, errorMessage: string | null): void {
    this.db
      .prepare(
        `UPDATE sessions SET status = ?, ended_at = datetime('now'), exit_code = ?, error_message = ? WHERE id = ?`,
      )
      .run(errorMessage ? 'error' : 'stopped', exitCode, errorMessage, id)
  }

  findById(id: string): SessionRow | null {
    return (
      this.db.prepare<[string], SessionRow>('SELECT * FROM sessions WHERE id = ?').get(id) ?? null
    )
  }

  listByWorkspace(workspacePath: string, limit = 50): SessionRow[] {
    return this.db
      .prepare<[string, number], SessionRow>(
        'SELECT * FROM sessions WHERE workspace_path = ? ORDER BY created_at DESC LIMIT ?',
      )
      .all(workspacePath, limit)
  }

  getLatest(workspacePath: string): SessionRow | null {
    return (
      this.db
        .prepare<[string], SessionRow>(
          'SELECT * FROM sessions WHERE workspace_path = ? ORDER BY created_at DESC LIMIT 1',
        )
        .get(workspacePath) ?? null
    )
  }

  close(): void {
    this.db.close()
  }
}
