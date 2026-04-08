import Database from 'better-sqlite3'

export interface AppSettings {
  model?: string
  effortLevel?: string
  permissionMode?: string
  maxTurns?: number
  maxBudgetUsd?: number
  appendSystemPrompt?: string
  addDirs?: string[]
  disallowedTools?: string[]
  chromeEnabled?: boolean
  theme?: string
}

interface SettingsRow {
  id: number
  scope: 'global' | 'project'
  workspace_path: string | null
  settings_json: string
}

export class SettingsStore {
  private readonly db: Database.Database

  constructor(db: Database.Database) {
    this.db = db
    this.migrate()
  }

  migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        scope TEXT NOT NULL CHECK(scope IN ('global', 'project')),
        workspace_path TEXT,
        settings_json TEXT NOT NULL DEFAULT '{}',
        UNIQUE(scope, workspace_path)
      );
    `)
  }

  getGlobalSettings(): AppSettings {
    const row = this.db
      .prepare<[], SettingsRow>(`SELECT * FROM settings WHERE scope = 'global' AND workspace_path IS NULL`)
      .get()
    if (!row) return {}
    return JSON.parse(row.settings_json) as AppSettings
  }

  getProjectSettings(workspacePath: string): AppSettings {
    const row = this.db
      .prepare<[string], SettingsRow>(`SELECT * FROM settings WHERE scope = 'project' AND workspace_path = ?`)
      .get(workspacePath)
    if (!row) return {}
    return JSON.parse(row.settings_json) as AppSettings
  }

  getEffectiveSettings(workspacePath: string): AppSettings {
    const defaults: AppSettings = {
      model: 'sonnet',
      effortLevel: 'medium',
      maxTurns: undefined,
      maxBudgetUsd: undefined,
    }
    const global = this.getGlobalSettings()
    const project = this.getProjectSettings(workspacePath)
    return { ...defaults, ...global, ...project }
  }

  updateGlobalSettings(partial: Partial<AppSettings>): AppSettings {
    const current = this.getGlobalSettings()
    const merged = { ...current, ...partial }
    const json = JSON.stringify(merged)
    // SQLite treats NULL as unique in UNIQUE constraints, so ON CONFLICT won't trigger.
    // Use explicit UPDATE-or-INSERT pattern instead.
    const updated = this.db
      .prepare(`UPDATE settings SET settings_json = ? WHERE scope = 'global' AND workspace_path IS NULL`)
      .run(json)
    if (updated.changes === 0) {
      this.db
        .prepare(`INSERT INTO settings (scope, workspace_path, settings_json) VALUES ('global', NULL, ?)`)
        .run(json)
    }
    return merged
  }

  updateProjectSettings(workspacePath: string, partial: Partial<AppSettings>): AppSettings {
    const current = this.getProjectSettings(workspacePath)
    const merged = { ...current, ...partial }
    this.db
      .prepare(`
        INSERT INTO settings (scope, workspace_path, settings_json)
        VALUES ('project', ?, ?)
        ON CONFLICT(scope, workspace_path) DO UPDATE SET settings_json = excluded.settings_json
      `)
      .run(workspacePath, JSON.stringify(merged))
    return merged
  }

  deleteProjectKey(workspacePath: string, key: keyof AppSettings): AppSettings {
    const current = this.getProjectSettings(workspacePath)
    delete current[key]
    this.db
      .prepare(`
        INSERT INTO settings (scope, workspace_path, settings_json)
        VALUES ('project', ?, ?)
        ON CONFLICT(scope, workspace_path) DO UPDATE SET settings_json = excluded.settings_json
      `)
      .run(workspacePath, JSON.stringify(current))
    return current
  }
}
