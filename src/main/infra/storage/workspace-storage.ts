import fs from "node:fs";
import path from "node:path";
import {
  DEFAULT_GIT_PANEL_STATE,
  type GitPanelState,
  GitPanelStateSchema,
  type GitPanelStateUpdate,
} from "../../../shared/git/types";
import { createLogger } from "../../../shared/log/main";
import {
  DEFAULT_VIEW_OPTIONS_BY_PANEL,
  type PanelKind,
  type PanelViewOptions,
  PanelViewOptionsSchema,
} from "../../../shared/types/panel";
import { type WorkspaceMeta, WorkspaceMetaSchema } from "../../../shared/types/workspace";
import type { SqliteDb } from "./migrations";
import { applyWorkspaceMigrations } from "./workspace-migrations";
import {
  defaultGitPanelState,
  GIT_PANEL_AUTOFETCH_INTERVAL_MIN_KEY,
  GIT_PANEL_AUTOFETCH_MANUAL_PAUSED_KEY,
  GIT_PANEL_COMMIT_DRAFT_KEY,
  GIT_PANEL_COMMIT_OPTIONS_KEY,
  GIT_PANEL_EXPANDED_GROUPS_KEY,
  GIT_PANEL_EXPANDED_TREE_NODES_KEY,
  GIT_PANEL_HISTORY_REF_KEY,
  GIT_PANEL_HISTORY_SCOPE_KEY,
  GIT_PANEL_PANEL_SEGMENT_KEY,
  GIT_PANEL_PROTECTED_BRANCHES_KEY,
  type GitPanelStateRow,
  parseGitAutofetchIntervalMin,
  parseGitAutofetchManualPaused,
  parseGitCommitOptions,
  parseGitExpandedGroups,
  parseGitExpandedTreeNodes,
  parseGitHistoryRef,
  parseGitHistoryScope,
  parseGitPanelSegment,
  parseGitProtectedBranches,
} from "./workspace-row-parsers";

const log = createLogger("workspace-storage");

interface PerWorkspaceEntry {
  db: SqliteDb;
  dbPath: string;
  workspaceDir: string;
}

type DbFactory = (dbPath: string) => SqliteDb;

export class WorkspaceStorage {
  private readonly entries = new Map<string, PerWorkspaceEntry>();
  private readonly gitPanelStates = new Map<string, GitPanelState>();
  private readonly baseDir: string;
  private readonly dbFactory: DbFactory;

  constructor(baseDir: string, dbFactory?: DbFactory) {
    this.baseDir = baseDir;
    if (dbFactory) {
      this.dbFactory = dbFactory;
    } else {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const BetterSQLite = require("better-sqlite3");
      this.dbFactory = (p: string) => new BetterSQLite(p) as SqliteDb;
    }
  }

  openForWorkspace(workspaceId: string): void {
    if (this.entries.has(workspaceId)) {
      return;
    }

    const workspaceDir = path.join(this.baseDir, workspaceId);

    if (process.env.NEXUS_RESET_STORAGE === "1" && fs.existsSync(workspaceDir)) {
      const backupName = `backup-${Date.now()}`;
      const backupDir = path.join(this.baseDir, backupName);
      fs.renameSync(workspaceDir, backupDir);
    }

    fs.mkdirSync(workspaceDir, { recursive: true });

    const dbPath = path.join(workspaceDir, "state.db");
    const db = this.dbFactory(dbPath);

    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA foreign_keys = ON;");
    db.exec(`
      CREATE TABLE IF NOT EXISTS _meta (
        key   TEXT NOT NULL PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    const row = db.prepare("SELECT value FROM _meta WHERE key = 'schemaVersion'").get() as
      | { value: string }
      | undefined;
    if (!row) {
      db.prepare("INSERT OR REPLACE INTO _meta (key, value) VALUES ('schemaVersion', '1')").run();
    }

    applyWorkspaceMigrations(db);

    this.entries.set(workspaceId, { db, dbPath, workspaceDir });
  }

  closeForWorkspace(workspaceId: string): void {
    const entry = this.entries.get(workspaceId);
    if (!entry) {
      return;
    }
    entry.db.close();
    this.entries.delete(workspaceId);
    this.gitPanelStates.delete(workspaceId);
  }

  getMeta(workspaceId: string): WorkspaceMeta | undefined {
    const entry = this.entries.get(workspaceId);
    if (!entry) {
      return undefined;
    }
    const row = entry.db.prepare("SELECT value FROM _meta WHERE key = 'workspaceMeta'").get() as
      | { value: string }
      | undefined;
    if (!row) {
      return undefined;
    }
    return WorkspaceMetaSchema.parse(JSON.parse(row.value) as unknown);
  }

  setMeta(workspaceId: string, meta: WorkspaceMeta): void {
    const entry = this.entries.get(workspaceId);
    if (!entry) {
      throw new Error(`workspace storage not open: ${workspaceId}`);
    }
    const normalized = WorkspaceMetaSchema.parse(meta);
    const serialized = JSON.stringify(normalized);
    entry.db
      .prepare("INSERT OR REPLACE INTO _meta (key, value) VALUES ('workspaceMeta', ?)")
      .run(serialized);

    const jsonPath = path.join(entry.workspaceDir, "workspace.json");
    fs.writeFileSync(jsonPath, JSON.stringify(normalized, null, 2), "utf8");
  }

  getWorkspaceDir(workspaceId: string): string {
    return path.join(this.baseDir, workspaceId);
  }

  isOpen(workspaceId: string): boolean {
    return this.entries.has(workspaceId);
  }

  getExpandedPaths(workspaceId: string): string[] {
    const entry = this.entries.get(workspaceId);
    if (!entry) {
      throw new Error(`workspace storage not open: ${workspaceId}`);
    }
    const rows = entry.db.prepare("SELECT rel_path FROM expanded_paths").all() as {
      rel_path: string;
    }[];
    return rows.map((r) => r.rel_path);
  }

  setExpandedPaths(workspaceId: string, relPaths: string[]): void {
    const entry = this.entries.get(workspaceId);
    if (!entry) {
      throw new Error(`workspace storage not open: ${workspaceId}`);
    }
    const del = entry.db.prepare("DELETE FROM expanded_paths");
    const ins = entry.db.prepare("INSERT INTO expanded_paths (rel_path) VALUES (?)");
    entry.db.exec("BEGIN");
    try {
      del.run();
      for (const rp of relPaths) {
        ins.run(rp);
      }
      entry.db.exec("COMMIT");
    } catch (err) {
      entry.db.exec("ROLLBACK");
      throw err;
    }
  }

  getGitPanelState(workspaceId: string): GitPanelState {
    const entry = this.entries.get(workspaceId);
    if (!entry) {
      throw new Error(`workspace storage not open: ${workspaceId}`);
    }
    const known = this.gitPanelStates.get(workspaceId);
    if (known) return known;
    const state = this.readGitPanelState(workspaceId, entry);
    this.gitPanelStates.set(workspaceId, state);
    return state;
  }

  private readGitPanelState(workspaceId: string, entry: PerWorkspaceEntry): GitPanelState {
    const rows = entry.db.prepare("SELECT * FROM git_panel_state").all() as GitPanelStateRow[];
    const values = new Map(rows.map((row) => [row.key, row.value]));
    const rowsByKey = new Map(rows.map((row) => [row.key, row]));
    const expandedGroups = parseGitExpandedGroups(
      workspaceId,
      values.get(GIT_PANEL_EXPANDED_GROUPS_KEY),
    );
    if (expandedGroups === null) {
      return defaultGitPanelState();
    }

    const expandedTreeNodes = parseGitExpandedTreeNodes(
      workspaceId,
      values.get(GIT_PANEL_EXPANDED_TREE_NODES_KEY),
    );
    const commitOptionsRow = rowsByKey.get(GIT_PANEL_COMMIT_OPTIONS_KEY);
    const autofetchIntervalRow = rowsByKey.get(GIT_PANEL_AUTOFETCH_INTERVAL_MIN_KEY);
    const autofetchManualPausedRow = rowsByKey.get(GIT_PANEL_AUTOFETCH_MANUAL_PAUSED_KEY);
    const protectedBranchesRow = rowsByKey.get(GIT_PANEL_PROTECTED_BRANCHES_KEY);

    const state = {
      commitDraft: values.get(GIT_PANEL_COMMIT_DRAFT_KEY) ?? DEFAULT_GIT_PANEL_STATE.commitDraft,
      expandedGroups,
      expandedTreeNodes,
      commitOptions: parseGitCommitOptions(
        workspaceId,
        values.get(GIT_PANEL_COMMIT_OPTIONS_KEY) ?? commitOptionsRow?.commit_options,
      ),
      autofetchIntervalMin: parseGitAutofetchIntervalMin(
        workspaceId,
        values.get(GIT_PANEL_AUTOFETCH_INTERVAL_MIN_KEY) ??
          autofetchIntervalRow?.autofetch_interval_min,
      ),
      autofetchManualPaused: parseGitAutofetchManualPaused(
        workspaceId,
        values.get(GIT_PANEL_AUTOFETCH_MANUAL_PAUSED_KEY) ??
          autofetchManualPausedRow?.autofetch_manual_paused,
      ),
      protectedBranches: parseGitProtectedBranches(
        workspaceId,
        values.get(GIT_PANEL_PROTECTED_BRANCHES_KEY) ?? protectedBranchesRow?.protected_branches,
      ),
      panelSegment: parseGitPanelSegment(workspaceId, values.get(GIT_PANEL_PANEL_SEGMENT_KEY)),
      historyRef: parseGitHistoryRef(workspaceId, values.get(GIT_PANEL_HISTORY_REF_KEY)),
      historyScope: parseGitHistoryScope(workspaceId, values.get(GIT_PANEL_HISTORY_SCOPE_KEY)),
    };
    const parsed = GitPanelStateSchema.safeParse(state);
    if (!parsed.success) {
      log.warn(
        `Invalid git_panel_state for workspace ${workspaceId}; using defaults. ${parsed.error.message}`,
      );
      return defaultGitPanelState();
    }
    return parsed.data;
  }

  setGitPanelState(workspaceId: string, state: GitPanelStateUpdate): void {
    const entry = this.entries.get(workspaceId);
    if (!entry) {
      throw new Error(`workspace storage not open: ${workspaceId}`);
    }

    const parsed = GitPanelStateSchema.partial().parse(state);
    this.gitPanelStates.delete(workspaceId);
    const ins = entry.db.prepare(
      "INSERT OR REPLACE INTO git_panel_state (key, value) VALUES (?, ?)",
    );
    const insCommitOptions = entry.db.prepare(
      "INSERT OR REPLACE INTO git_panel_state (key, value, commit_options) VALUES (?, ?, ?)",
    );
    const insAutofetchInterval = entry.db.prepare(
      "INSERT OR REPLACE INTO git_panel_state (key, value, autofetch_interval_min) VALUES (?, ?, ?)",
    );
    const insAutofetchManualPaused = entry.db.prepare(
      "INSERT OR REPLACE INTO git_panel_state (key, value, autofetch_manual_paused) VALUES (?, ?, ?)",
    );
    const insProtectedBranches = entry.db.prepare(
      "INSERT OR REPLACE INTO git_panel_state (key, value, protected_branches) VALUES (?, ?, ?)",
    );
    entry.db.exec("BEGIN");
    try {
      if (parsed.commitDraft !== undefined) {
        ins.run(GIT_PANEL_COMMIT_DRAFT_KEY, parsed.commitDraft);
      }
      if (parsed.expandedGroups !== undefined) {
        ins.run(GIT_PANEL_EXPANDED_GROUPS_KEY, JSON.stringify(parsed.expandedGroups));
      }
      if (parsed.expandedTreeNodes !== undefined) {
        ins.run(GIT_PANEL_EXPANDED_TREE_NODES_KEY, JSON.stringify(parsed.expandedTreeNodes));
      }
      if (parsed.commitOptions !== undefined) {
        const serialized = JSON.stringify(parsed.commitOptions);
        insCommitOptions.run(GIT_PANEL_COMMIT_OPTIONS_KEY, serialized, serialized);
      }
      if (parsed.autofetchIntervalMin !== undefined) {
        insAutofetchInterval.run(
          GIT_PANEL_AUTOFETCH_INTERVAL_MIN_KEY,
          String(parsed.autofetchIntervalMin),
          parsed.autofetchIntervalMin,
        );
      }
      if (parsed.autofetchManualPaused !== undefined) {
        const value = parsed.autofetchManualPaused ? 1 : 0;
        insAutofetchManualPaused.run(GIT_PANEL_AUTOFETCH_MANUAL_PAUSED_KEY, String(value), value);
      }
      if (parsed.protectedBranches !== undefined) {
        const serialized = JSON.stringify(parsed.protectedBranches);
        insProtectedBranches.run(GIT_PANEL_PROTECTED_BRANCHES_KEY, serialized, serialized);
      }
      if (parsed.panelSegment !== undefined) {
        ins.run(GIT_PANEL_PANEL_SEGMENT_KEY, parsed.panelSegment);
      }
      if (parsed.historyRef !== undefined) {
        ins.run(GIT_PANEL_HISTORY_REF_KEY, parsed.historyRef);
      }
      if (parsed.historyScope !== undefined) {
        ins.run(GIT_PANEL_HISTORY_SCOPE_KEY, parsed.historyScope);
      }
      entry.db.exec("COMMIT");
    } catch (err) {
      entry.db.exec("ROLLBACK");
      throw err;
    }
  }

  getPanelViewOptions(workspaceId: string, panelKind: PanelKind): PanelViewOptions {
    const entry = this.entries.get(workspaceId);
    if (!entry) {
      throw new Error(`workspace storage not open: ${workspaceId}`);
    }

    const row = entry.db
      .prepare("SELECT view_mode FROM panel_view_options WHERE panel_kind = ?")
      .get(panelKind) as { view_mode: string } | undefined;

    if (!row) {
      return { ...DEFAULT_VIEW_OPTIONS_BY_PANEL[panelKind] };
    }

    const parsed = PanelViewOptionsSchema.safeParse({
      viewMode: row.view_mode,
    });
    if (!parsed.success) {
      log.warn(
        `Invalid panel_view_options for workspace ${workspaceId} panel ${panelKind}; using defaults. ${parsed.error.message}`,
      );
      return { ...DEFAULT_VIEW_OPTIONS_BY_PANEL[panelKind] };
    }
    return parsed.data;
  }

  setPanelViewOptions(
    workspaceId: string,
    panelKind: PanelKind,
    partial: Partial<PanelViewOptions>,
  ): void {
    const entry = this.entries.get(workspaceId);
    if (!entry) {
      throw new Error(`workspace storage not open: ${workspaceId}`);
    }

    const current = this.getPanelViewOptions(workspaceId, panelKind);
    const merged = PanelViewOptionsSchema.parse({ ...current, ...partial });

    entry.db
      .prepare(
        `INSERT OR REPLACE INTO panel_view_options (panel_kind, view_mode)
         VALUES (?, ?)`,
      )
      .run(panelKind, merged.viewMode);
  }

  getOriginPermission(
    workspaceId: string,
    origin: string,
    permission: string,
  ): "allow" | "block" | null {
    const entry = this.entries.get(workspaceId);
    if (!entry) {
      throw new Error(`workspace storage not open: ${workspaceId}`);
    }
    const row = entry.db
      .prepare("SELECT decision FROM origin_permissions WHERE origin = ? AND permission = ?")
      .get(origin, permission) as { decision: string } | undefined;
    if (!row) return null;
    return row.decision as "allow" | "block";
  }

  setOriginPermission(
    workspaceId: string,
    origin: string,
    permission: string,
    decision: "allow" | "block",
  ): void {
    const entry = this.entries.get(workspaceId);
    if (!entry) {
      throw new Error(`workspace storage not open: ${workspaceId}`);
    }
    entry.db
      .prepare(
        `INSERT OR REPLACE INTO origin_permissions (origin, permission, decision, updated_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(origin, permission, decision, Date.now());
  }

  listOriginPermissions(
    workspaceId: string,
  ): { origin: string; permission: string; decision: "allow" | "block" }[] {
    const entry = this.entries.get(workspaceId);
    if (!entry) {
      throw new Error(`workspace storage not open: ${workspaceId}`);
    }
    const rows = entry.db
      .prepare("SELECT origin, permission, decision FROM origin_permissions")
      .all() as { origin: string; permission: string; decision: string }[];
    return rows as { origin: string; permission: string; decision: "allow" | "block" }[];
  }

  deleteOriginPermission(workspaceId: string, origin: string, permission: string): void {
    const entry = this.entries.get(workspaceId);
    if (!entry) {
      throw new Error(`workspace storage not open: ${workspaceId}`);
    }
    entry.db
      .prepare("DELETE FROM origin_permissions WHERE origin = ? AND permission = ?")
      .run(origin, permission);
  }

  clearOrigin(workspaceId: string, origin: string): void {
    const entry = this.entries.get(workspaceId);
    if (!entry) {
      throw new Error(`workspace storage not open: ${workspaceId}`);
    }
    entry.db.prepare("DELETE FROM origin_permissions WHERE origin = ?").run(origin);
  }
}
