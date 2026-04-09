import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'
import { PROTECTED_DIRS } from '@nexus/shared'

export interface ApprovalRule {
  id: string
  toolName: string
  scope: 'session' | 'permanent'
  workspacePath: string | null
  decision: 'allow' | 'deny'
  sessionId: string | null
  createdAt: string
}

export interface AuditLogEntry {
  id: number
  toolName: string
  toolUseId: string
  sessionId: string | null
  workspacePath: string | null
  decision: string
  scope: string
  createdAt: string
}

export class ApprovalPolicyStore {
  private readonly db: Database.Database

  constructor(db: Database.Database) {
    this.db = db
    this.migrate()
  }

  migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS approval_rules (
        id TEXT PRIMARY KEY,
        tool_name TEXT NOT NULL,
        scope TEXT NOT NULL DEFAULT 'permanent',
        workspace_path TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_approval_rules_tool ON approval_rules(tool_name);
      CREATE TABLE IF NOT EXISTS approval_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tool_name TEXT NOT NULL,
        tool_use_id TEXT NOT NULL,
        session_id TEXT,
        workspace_path TEXT,
        decision TEXT NOT NULL,
        scope TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_approval_logs_workspace ON approval_logs(workspace_path);
    `)

    // Idempotent column additions for schema migration
    type ColumnInfo = { name: string }
    const columns = this.db.prepare(`PRAGMA table_info(approval_rules)`).all() as ColumnInfo[]
    const columnNames = new Set(columns.map((c) => c.name))

    if (!columnNames.has('decision')) {
      this.db.exec(`ALTER TABLE approval_rules ADD COLUMN decision TEXT NOT NULL DEFAULT 'allow' CHECK(decision IN ('allow', 'deny'))`)
    }
    if (!columnNames.has('session_id')) {
      this.db.exec(`ALTER TABLE approval_rules ADD COLUMN session_id TEXT`)
    }
  }

  addRule(params: {
    toolName: string
    scope: 'session' | 'permanent'
    workspacePath: string | null
    decision?: 'allow' | 'deny'
    sessionId?: string
  }): ApprovalRule {
    const decision = params.decision ?? 'allow'

    // Layer 2 guard: reject rules targeting workspace-level protected directories
    if (params.workspacePath !== null && params.workspacePath !== undefined) {
      for (const protectedDir of PROTECTED_DIRS) {
        if (
          params.workspacePath === protectedDir ||
          params.workspacePath.endsWith('/' + protectedDir)
        ) {
          throw new Error(`Cannot add rule for protected path: ${params.workspacePath}`)
        }
      }
    }

    const id = randomUUID()
    type RuleRow = {
      id: string
      tool_name: string
      scope: string
      workspace_path: string | null
      decision: string
      session_id: string | null
      created_at: string
    }
    const stmt = this.db.prepare<
      [string, string, string, string | null, string, string | null],
      RuleRow
    >(`
      INSERT INTO approval_rules (id, tool_name, scope, workspace_path, decision, session_id)
      VALUES (?, ?, ?, ?, ?, ?)
      RETURNING *
    `)
    const row = stmt.get(
      id,
      params.toolName,
      params.scope,
      params.workspacePath ?? null,
      decision,
      params.sessionId ?? null,
    )!
    return {
      id: row.id,
      toolName: row.tool_name,
      scope: row.scope as 'session' | 'permanent',
      workspacePath: row.workspace_path,
      decision: row.decision as 'allow' | 'deny',
      sessionId: row.session_id,
      createdAt: row.created_at,
    }
  }

  /** @deprecated Use addRule({ scope: 'permanent', ... }) instead */
  addPermanentRule(toolName: string, workspacePath?: string): ApprovalRule {
    return this.addRule({ toolName, scope: 'permanent', workspacePath: workspacePath ?? null })
  }

  removePermanentRule(id: string): void {
    this.db.prepare('DELETE FROM approval_rules WHERE id = ?').run(id)
  }

  listPermanentRules(workspacePath?: string): ApprovalRule[] {
    type RuleRow = {
      id: string
      tool_name: string
      scope: string
      workspace_path: string | null
      decision: string
      session_id: string | null
      created_at: string
    }
    let rows: RuleRow[]
    if (workspacePath !== undefined) {
      rows = this.db
        .prepare<[string | null], RuleRow>(
          `SELECT * FROM approval_rules WHERE (workspace_path = ? OR workspace_path IS NULL) AND scope = 'permanent' ORDER BY created_at ASC`,
        )
        .all(workspacePath)
    } else {
      rows = this.db
        .prepare<[], RuleRow>(`SELECT * FROM approval_rules WHERE scope = 'permanent' ORDER BY created_at ASC`)
        .all()
    }
    return rows.map((row) => ({
      id: row.id,
      toolName: row.tool_name,
      scope: 'permanent' as const,
      workspacePath: row.workspace_path,
      decision: (row.decision ?? 'allow') as 'allow' | 'deny',
      sessionId: row.session_id,
      createdAt: row.created_at,
    }))
  }

  /** @deprecated Use addRule({ scope: 'session', sessionId, ... }) instead */
  addSessionRule(toolName: string, workspacePath?: string, sessionId?: string): void {
    this.addRule({ toolName, scope: 'session', workspacePath: workspacePath ?? null, sessionId })
  }

  deleteSessionRules(sessionId: string): number {
    const result = this.db.prepare(`DELETE FROM approval_rules WHERE session_id = ?`).run(sessionId)
    return result.changes
  }

  /** @deprecated No-op: session rules are now persisted in DB and cleaned up per-session via deleteSessionRules */
  clearSessionRules(): void {
    // intentional no-op — session rules live in DB, cleaned up by deleteSessionRules
  }

  matchRule(toolName: string, workspacePath: string | null, sessionId?: string): ApprovalRule | null {
    type RuleRow = {
      id: string
      tool_name: string
      scope: string
      workspace_path: string | null
      decision: string
      session_id: string | null
      created_at: string
    }
    const row = this.db
      .prepare<[string, string | null, string | null, string | null, string], RuleRow>(
        `SELECT * FROM approval_rules
         WHERE (tool_name = ? OR tool_name = '*')
           AND (workspace_path = ? OR workspace_path IS NULL)
           AND (session_id IS NULL OR session_id = ?)
         ORDER BY
           CASE WHEN workspace_path = ? THEN 1 ELSE 2 END,
           CASE WHEN tool_name = ? THEN 1 ELSE 2 END,
           CASE WHEN decision = 'deny' THEN 1 ELSE 2 END
         LIMIT 1`,
      )
      .get(toolName, workspacePath, sessionId ?? null, workspacePath, toolName)

    if (!row) return null

    return {
      id: row.id,
      toolName: row.tool_name,
      scope: row.scope as 'session' | 'permanent',
      workspacePath: row.workspace_path,
      decision: (row.decision ?? 'allow') as 'allow' | 'deny',
      sessionId: row.session_id,
      createdAt: row.created_at,
    }
  }

  logDecision(entry: {
    toolName: string
    toolUseId: string
    sessionId: string
    workspacePath: string
    decision: string
    scope: string
  }): void {
    this.db
      .prepare(
        `INSERT INTO approval_logs (tool_name, tool_use_id, session_id, workspace_path, decision, scope)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.toolName,
        entry.toolUseId,
        entry.sessionId,
        entry.workspacePath,
        entry.decision,
        entry.scope,
      )
  }

  getAuditLog(workspacePath?: string, limit = 100): AuditLogEntry[] {
    type LogRow = {
      id: number
      tool_name: string
      tool_use_id: string
      session_id: string | null
      workspace_path: string | null
      decision: string
      scope: string
      created_at: string
    }
    let rows: LogRow[]
    if (workspacePath !== undefined) {
      rows = this.db
        .prepare<[string, number], LogRow>(
          `SELECT * FROM approval_logs WHERE workspace_path = ? ORDER BY id DESC LIMIT ?`,
        )
        .all(workspacePath, limit)
    } else {
      rows = this.db
        .prepare<[number], LogRow>(`SELECT * FROM approval_logs ORDER BY id DESC LIMIT ?`)
        .all(limit)
    }
    return rows.map((row) => ({
      id: row.id,
      toolName: row.tool_name,
      toolUseId: row.tool_use_id,
      sessionId: row.session_id,
      workspacePath: row.workspace_path,
      decision: row.decision,
      scope: row.scope,
      createdAt: row.created_at,
    }))
  }
}
