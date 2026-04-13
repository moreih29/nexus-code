import { Database } from 'bun:sqlite'

export interface WorkspaceRow {
  id: string
  path: string
  name: string | null
  created_at: string
}

export class WorkspaceStore {
  private db: Database

  constructor(db: Database) {
    this.db = db
    this.migrate()
  }

  migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS workspaces (
        id TEXT PRIMARY KEY,
        path TEXT NOT NULL UNIQUE,
        name TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `)
  }

  create(workspace: { id: string; path: string; name?: string }): WorkspaceRow {
    const stmt = this.db.prepare<WorkspaceRow, [string, string, string | null]>(`
      INSERT INTO workspaces (id, path, name)
      VALUES (?, ?, ?)
      RETURNING *
    `)
    return stmt.get(workspace.id, workspace.path, workspace.name ?? null)!
  }

  remove(path: string): boolean {
    const result = this.db
      .prepare<unknown, [string]>('DELETE FROM workspaces WHERE path = ?')
      .run(path)
    return result.changes > 0
  }

  findByPath(path: string): WorkspaceRow | null {
    return (
      this.db
        .prepare<WorkspaceRow, [string]>('SELECT * FROM workspaces WHERE path = ?')
        .get(path) ?? null
    )
  }

  list(): WorkspaceRow[] {
    return this.db
      .prepare<WorkspaceRow, []>('SELECT * FROM workspaces ORDER BY created_at ASC')
      .all()
  }
}
