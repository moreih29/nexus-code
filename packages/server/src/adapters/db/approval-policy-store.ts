import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'

export interface ApprovalRule {
  id: string
  toolName: string
  scope: 'session' | 'permanent'
  workspacePath: string | null
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
  private readonly sessionRules: ApprovalRule[] = []

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
  }

  addPermanentRule(toolName: string, workspacePath?: string): ApprovalRule {
    const id = randomUUID()
    const stmt = this.db.prepare<
      [string, string, string | null],
      { id: string; tool_name: string; scope: string; workspace_path: string | null; created_at: string }
    >(`
      INSERT INTO approval_rules (id, tool_name, scope, workspace_path)
      VALUES (?, ?, 'permanent', ?)
      RETURNING *
    `)
    const row = stmt.get(id, toolName, workspacePath ?? null)!
    return {
      id: row.id,
      toolName: row.tool_name,
      scope: 'permanent',
      workspacePath: row.workspace_path,
      createdAt: row.created_at,
    }
  }

  removePermanentRule(id: string): void {
    this.db.prepare('DELETE FROM approval_rules WHERE id = ?').run(id)
  }

  listPermanentRules(workspacePath?: string): ApprovalRule[] {
    type RuleRow = { id: string; tool_name: string; scope: string; workspace_path: string | null; created_at: string }
    let rows: RuleRow[]
    if (workspacePath !== undefined) {
      rows = this.db
        .prepare<[string | null], RuleRow>(
          `SELECT * FROM approval_rules WHERE workspace_path = ? OR workspace_path IS NULL ORDER BY created_at ASC`,
        )
        .all(workspacePath)
    } else {
      rows = this.db
        .prepare<[], RuleRow>(`SELECT * FROM approval_rules ORDER BY created_at ASC`)
        .all()
    }
    return rows.map((row) => ({
      id: row.id,
      toolName: row.tool_name,
      scope: 'permanent' as const,
      workspacePath: row.workspace_path,
      createdAt: row.created_at,
    }))
  }

  addSessionRule(toolName: string, workspacePath?: string): void {
    this.sessionRules.push({
      id: randomUUID(),
      toolName,
      scope: 'session',
      workspacePath: workspacePath ?? null,
      createdAt: new Date().toISOString(),
    })
  }

  clearSessionRules(): void {
    this.sessionRules.length = 0
  }

  matchRule(toolName: string, workspacePath: string): ApprovalRule | null {
    // permanent rules first
    type RuleRow = { id: string; tool_name: string; scope: string; workspace_path: string | null; created_at: string }
    const row = this.db
      .prepare<[string, string, string], RuleRow>(
        `SELECT * FROM approval_rules
         WHERE (tool_name = ? OR tool_name = '*')
           AND (workspace_path = ? OR workspace_path IS NULL)
         ORDER BY
           CASE WHEN workspace_path IS NOT NULL THEN 0 ELSE 1 END,
           CASE WHEN tool_name != '*' THEN 0 ELSE 1 END
         LIMIT 1`,
      )
      .get(toolName, workspacePath, toolName)

    if (row) {
      return {
        id: row.id,
        toolName: row.tool_name,
        scope: 'permanent',
        workspacePath: row.workspace_path,
        createdAt: row.created_at,
      }
    }

    // session rules
    for (const rule of this.sessionRules) {
      const toolMatches = rule.toolName === toolName || rule.toolName === '*'
      const pathMatches = rule.workspacePath === null || rule.workspacePath === workspacePath
      if (toolMatches && pathMatches) {
        return rule
      }
    }

    return null
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
