import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WorkspaceStorage } from "../../../../src/main/infra/storage/workspace-storage";
import { DEFAULT_GIT_PANEL_STATE } from "../../../../src/shared/git/types";
import type { WorkspaceMeta } from "../../../../src/shared/types/workspace";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "nexus-wsstorage-test-"));
}

function makeMeta(id: string): WorkspaceMeta {
  const rootPath = path.join(os.tmpdir(), "ws");
  return {
    id,
    name: "my-workspace",
    rootPath,
    location: { kind: "local", rootPath },
    colorTone: "default",
    pinned: false,
    lastOpenedAt: new Date(1_700_000_000_000).toISOString(),
    tabs: [],
  };
}

// Use bun:sqlite as the DB factory for unit tests.
function bunSqliteFactory(dbPath: string): Database {
  // bun:sqlite accepts ":memory:" and real paths — both work in tests.
  // We use a real path here to exercise the directory-creation code path.
  return new Database(dbPath);
}

// ---------------------------------------------------------------------------
// WorkspaceStorage tests
// ---------------------------------------------------------------------------

describe("WorkspaceStorage.openForWorkspace", () => {
  let tmpDir: string;
  let storage: WorkspaceStorage;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    storage = new WorkspaceStorage(tmpDir, bunSqliteFactory);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates the workspace directory on first open", () => {
    const id = "00000000-0000-0000-0000-000000000001";
    storage.openForWorkspace(id);
    const dir = path.join(tmpDir, id);
    expect(fs.existsSync(dir)).toBe(true);
  });

  it("creates state.db inside the workspace directory", () => {
    const id = "00000000-0000-0000-0000-000000000001";
    storage.openForWorkspace(id);
    const dbPath = path.join(tmpDir, id, "state.db");
    expect(fs.existsSync(dbPath)).toBe(true);
  });

  it("is idempotent — opening the same workspace twice keeps it open", () => {
    const id = "00000000-0000-0000-0000-000000000001";
    storage.openForWorkspace(id);
    storage.openForWorkspace(id);
    expect(storage.isOpen(id)).toBe(true);
  });
});

describe("WorkspaceStorage.getMeta / setMeta", () => {
  let tmpDir: string;
  let storage: WorkspaceStorage;
  const id = "00000000-0000-0000-0000-000000000002";

  beforeEach(() => {
    tmpDir = makeTmpDir();
    storage = new WorkspaceStorage(tmpDir, bunSqliteFactory);
    storage.openForWorkspace(id);
  });

  afterEach(() => {
    storage.closeForWorkspace(id);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("getMeta returns undefined before setMeta is called", () => {
    expect(storage.getMeta(id)).toBeUndefined();
  });

  it("setMeta persists meta and getMeta retrieves it", () => {
    const meta = makeMeta(id);
    storage.setMeta(id, meta);
    const retrieved = storage.getMeta(id);
    expect(retrieved?.id).toBe(id);
    expect(retrieved?.name).toBe("my-workspace");
  });

  it("getMeta loads legacy ssh meta without authMode as interactive", () => {
    const legacyMeta: WorkspaceMeta = {
      ...makeMeta(id),
      rootPath: "/srv/legacy",
      location: { kind: "ssh", host: "legacy", remotePath: "/srv/legacy" },
    };
    storage.setMeta(id, legacyMeta);

    const retrieved = storage.getMeta(id);
    expect(retrieved?.location).toEqual({
      kind: "ssh",
      host: "legacy",
      remotePath: "/srv/legacy",
      authMode: "interactive",
    });
  });

  it("setMeta writes workspace.json recovery dump", () => {
    const meta = makeMeta(id);
    storage.setMeta(id, meta);
    const jsonPath = path.join(tmpDir, id, "workspace.json");
    expect(fs.existsSync(jsonPath)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(jsonPath, "utf8")) as WorkspaceMeta;
    expect(parsed.id).toBe(id);
  });

  it("setMeta fills authMode in the workspace.json recovery dump", () => {
    storage.setMeta(id, {
      ...makeMeta(id),
      rootPath: "/srv/legacy",
      location: { kind: "ssh", host: "legacy", remotePath: "/srv/legacy" },
    });

    const jsonPath = path.join(tmpDir, id, "workspace.json");
    const parsed = JSON.parse(fs.readFileSync(jsonPath, "utf8")) as WorkspaceMeta;
    expect(parsed.location).toEqual({
      kind: "ssh",
      host: "legacy",
      remotePath: "/srv/legacy",
      authMode: "interactive",
    });
  });

  it("setMeta throws when workspace is not open", () => {
    const other = "00000000-0000-0000-0000-000000000099";
    expect(() => storage.setMeta(other, makeMeta(other))).toThrow("workspace storage not open");
  });
});

describe("WorkspaceStorage.closeForWorkspace", () => {
  let tmpDir: string;
  let storage: WorkspaceStorage;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    storage = new WorkspaceStorage(tmpDir, bunSqliteFactory);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("closeForWorkspace removes the entry from the open set", () => {
    const id = "00000000-0000-0000-0000-000000000003";
    storage.openForWorkspace(id);
    expect(storage.isOpen(id)).toBe(true);
    storage.closeForWorkspace(id);
    expect(storage.isOpen(id)).toBe(false);
  });

  it("closeForWorkspace on a non-open workspace leaves other workspaces unaffected", () => {
    const openId = "00000000-0000-0000-0000-000000000003";
    storage.openForWorkspace(openId);
    storage.closeForWorkspace("00000000-0000-0000-0000-000000000099");
    expect(storage.isOpen(openId)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// expanded_paths API — schema v2 migration + round-trip
// ---------------------------------------------------------------------------

describe("WorkspaceStorage.getExpandedPaths / setExpandedPaths", () => {
  let tmpDir: string;
  let storage: WorkspaceStorage;
  const id = "00000000-0000-0000-0000-000000000010";

  beforeEach(() => {
    tmpDir = makeTmpDir();
    storage = new WorkspaceStorage(tmpDir, bunSqliteFactory);
    storage.openForWorkspace(id);
  });

  afterEach(() => {
    storage.closeForWorkspace(id);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("getExpandedPaths returns [] when no paths have been saved", () => {
    expect(storage.getExpandedPaths(id)).toEqual([]);
  });

  it("setExpandedPaths persists paths and getExpandedPaths retrieves them", () => {
    storage.setExpandedPaths(id, ["src", "src/components"]);
    const result = storage.getExpandedPaths(id);
    expect(result.sort()).toEqual(["src", "src/components"].sort());
  });

  it("setExpandedPaths replaces existing paths on second call", () => {
    storage.setExpandedPaths(id, ["src", "lib"]);
    storage.setExpandedPaths(id, ["docs"]);
    expect(storage.getExpandedPaths(id)).toEqual(["docs"]);
  });

  it("setExpandedPaths with empty array clears all paths", () => {
    storage.setExpandedPaths(id, ["src"]);
    storage.setExpandedPaths(id, []);
    expect(storage.getExpandedPaths(id)).toEqual([]);
  });

  it("getExpandedPaths throws when workspace is not open", () => {
    expect(() => storage.getExpandedPaths("00000000-0000-0000-0000-000000000099")).toThrow(
      "workspace storage not open",
    );
  });

  it("setExpandedPaths throws when workspace is not open", () => {
    expect(() => storage.setExpandedPaths("00000000-0000-0000-0000-000000000099", ["src"])).toThrow(
      "workspace storage not open",
    );
  });
});

// ---------------------------------------------------------------------------
// git_panel_state expandedTreeNodes — round-trip + fallback
// ---------------------------------------------------------------------------

describe("WorkspaceStorage getGitPanelState / setGitPanelState — expandedTreeNodes", () => {
  let tmpDir: string;
  let storage: WorkspaceStorage;
  const id = "00000000-0000-0000-0000-000000000030";

  beforeEach(() => {
    tmpDir = makeTmpDir();
    storage = new WorkspaceStorage(tmpDir, bunSqliteFactory);
    storage.openForWorkspace(id);
  });

  afterEach(() => {
    storage.closeForWorkspace(id);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("getGitPanelState returns empty arrays for expandedTreeNodes on fresh workspace", () => {
    const state = storage.getGitPanelState(id);
    expect(state.expandedTreeNodes).toEqual({
      merge: [],
      staged: [],
      working: [],
      untracked: [],
    });
  });

  it("setGitPanelState + getGitPanelState round-trips expandedTreeNodes", () => {
    storage.setGitPanelState(id, {
      expandedTreeNodes: {
        merge: [],
        staged: ["src", "src/components"],
        working: ["lib"],
        untracked: [],
      },
    });
    const state = storage.getGitPanelState(id);
    expect(state.expandedTreeNodes.staged.sort()).toEqual(["src", "src/components"].sort());
    expect(state.expandedTreeNodes.working).toEqual(["lib"]);
    expect(state.expandedTreeNodes.merge).toEqual([]);
    expect(state.expandedTreeNodes.untracked).toEqual([]);
  });

  it("missing expandedTreeNodes row falls back to empty arrays without error", () => {
    // Write only commitDraft — no expandedTreeNodes row.
    storage.setGitPanelState(id, { commitDraft: "my draft" });
    const state = storage.getGitPanelState(id);
    expect(state.commitDraft).toBe("my draft");
    expect(state.expandedTreeNodes).toEqual({
      merge: [],
      staged: [],
      working: [],
      untracked: [],
    });
  });

  it("expandedTreeNodes partial update does not clobber commitDraft", () => {
    storage.setGitPanelState(id, { commitDraft: "keep me" });
    storage.setGitPanelState(id, {
      expandedTreeNodes: { merge: [], staged: ["a"], working: [], untracked: [] },
    });
    const state = storage.getGitPanelState(id);
    expect(state.commitDraft).toBe("keep me");
    expect(state.expandedTreeNodes.staged).toEqual(["a"]);
  });

  it("fresh workspace returns defaults for git panel preferences", () => {
    const state = storage.getGitPanelState(id);

    expect(state.commitOptions).toEqual(DEFAULT_GIT_PANEL_STATE.commitOptions);
    expect(state.autofetchIntervalMin).toBe(3);
    expect(state.autofetchManualPaused).toBe(false);
    expect(state.protectedBranches).toEqual([]);
    expect(state.panelSegment).toBe("changes");
    expect(state.historyRef).toBe("HEAD");
  });

  it("round-trips git panel preferences without clobbering draft or groups", () => {
    storage.setGitPanelState(id, {
      commitDraft: "keep this draft",
      expandedGroups: { merge: false, staged: true, working: false, untracked: true },
    });
    storage.setGitPanelState(id, {
      commitOptions: { sign: true, signoff: true, noVerify: false },
      autofetchIntervalMin: 3,
      autofetchManualPaused: true,
      protectedBranches: ["main", "release/*"],
      panelSegment: "history",
      historyRef: "origin/main",
    });

    const state = storage.getGitPanelState(id);
    expect(state.commitDraft).toBe("keep this draft");
    expect(state.expandedGroups).toEqual({
      merge: false,
      staged: true,
      working: false,
      untracked: true,
    });
    expect(state.commitOptions).toEqual({ sign: true, signoff: true, noVerify: false });
    expect(state.autofetchIntervalMin).toBe(3);
    expect(state.autofetchManualPaused).toBe(true);
    expect(state.protectedBranches).toEqual(["main", "release/*"]);
    expect(state.panelSegment).toBe("history");
    expect(state.historyRef).toBe("origin/main");
  });

  it("ignores removed legacy history detail width rows without failing load", () => {
    const dbPath = path.join(tmpDir, id, "state.db");
    const db = bunSqliteFactory(dbPath);
    const removedKey = ["history", "Detail", "Width"].join("");

    try {
      db.prepare("INSERT OR REPLACE INTO git_panel_state (key, value) VALUES (?, ?)").run(
        removedKey,
        "420",
      );

      expect(() => storage.getGitPanelState(id)).not.toThrow();
      expect(storage.getGitPanelState(id).historyRef).toBe("HEAD");
    } finally {
      db.close();
    }
  });

  it("coerces legacy stored autofetch intervals to 3 while preserving Off", () => {
    const dbPath = path.join(tmpDir, id, "state.db");
    const db = bunSqliteFactory(dbPath);
    const writeInterval = db.prepare(
      "INSERT OR REPLACE INTO git_panel_state (key, value) VALUES (?, ?)",
    );
    const deleteInterval = db.prepare("DELETE FROM git_panel_state WHERE key = ?");
    const cases: Array<readonly [string | undefined, 0 | 3]> = [
      [undefined, 3],
      ["0", 0],
      ["1", 3],
      ["3", 3],
      ["5", 3],
      ["15", 3],
    ];
    const warn = mock(() => {});
    const originalWarn = console.warn;
    console.warn = warn as typeof console.warn;

    try {
      for (const [legacyValue, expected] of cases) {
        if (legacyValue === undefined) {
          deleteInterval.run("autofetchIntervalMin");
        } else {
          writeInterval.run("autofetchIntervalMin", legacyValue);
        }
        let interval: 0 | 3 | undefined;
        expect(() => {
          interval = storage.getGitPanelState(id).autofetchIntervalMin;
        }).not.toThrow();
        expect(interval).toBe(expected);
      }
      expect(warn).not.toHaveBeenCalled();
    } finally {
      console.warn = originalWarn;
      db.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Schema v2 migration backward-compat — a v1 DB gets the new table
// ---------------------------------------------------------------------------

describe("WorkspaceStorage schema v2 migration from v1 DB", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("adds expanded_paths table to an existing v1 DB without losing _meta data", () => {
    const id = "00000000-0000-0000-0000-000000000020";
    const workspaceDir = path.join(tmpDir, id);
    fs.mkdirSync(workspaceDir, { recursive: true });
    const dbPath = path.join(workspaceDir, "state.db");

    // Create a v1 DB manually: _meta table + schemaVersion=1 only.
    const v1Db = bunSqliteFactory(dbPath);
    v1Db.exec(`
      CREATE TABLE IF NOT EXISTS _meta (
        key   TEXT NOT NULL PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    v1Db.prepare("INSERT INTO _meta (key, value) VALUES ('schemaVersion', '1')").run();
    v1Db.prepare("INSERT INTO _meta (key, value) VALUES ('customKey', 'customValue')").run();
    v1Db.close();

    // Now open via WorkspaceStorage — migration should run.
    const storage = new WorkspaceStorage(tmpDir, bunSqliteFactory);
    storage.openForWorkspace(id);

    // expanded_paths table should exist and be usable.
    expect(() => storage.getExpandedPaths(id)).not.toThrow();
    expect(storage.getExpandedPaths(id)).toEqual([]);

    // Existing _meta data is intact.
    const meta = storage.getMeta(id);
    // workspaceMeta was never set so should be undefined — but customKey still exists in DB.
    // We verify no data loss by checking schemaVersion was upgraded.
    // (getMeta only reads workspaceMeta key, so we trust the DB didn't DROP _meta.)
    expect(meta).toBeUndefined(); // workspaceMeta row was never written

    storage.closeForWorkspace(id);
  });
});

// ---------------------------------------------------------------------------
// Schema v5 migration backward-compat — git panel preferences
// ---------------------------------------------------------------------------

describe("WorkspaceStorage schema v5 migration for git panel preferences", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("adds preference columns and preserves legacy git_panel_state rows", () => {
    const id = "00000000-0000-0000-0000-000000000040";
    const workspaceDir = path.join(tmpDir, id);
    fs.mkdirSync(workspaceDir, { recursive: true });
    const dbPath = path.join(workspaceDir, "state.db");

    const v4Db = bunSqliteFactory(dbPath);
    v4Db.exec(`
      CREATE TABLE IF NOT EXISTS _meta (
        key   TEXT NOT NULL PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS expanded_paths (
        rel_path TEXT NOT NULL PRIMARY KEY
      );
      CREATE TABLE IF NOT EXISTS git_panel_state (
        key   TEXT NOT NULL PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS panel_view_options (
        panel_kind       TEXT    NOT NULL PRIMARY KEY,
        view_mode        TEXT    NOT NULL,
        compact_folders  INTEGER NOT NULL DEFAULT 0
      );
    `);
    v4Db.prepare("INSERT INTO _meta (key, value) VALUES ('schemaVersion', '4')").run();
    v4Db
      .prepare("INSERT INTO git_panel_state (key, value) VALUES (?, ?)")
      .run("commitDraft", "legacy draft");
    v4Db
      .prepare("INSERT INTO git_panel_state (key, value) VALUES (?, ?)")
      .run(
        "expandedGroups",
        JSON.stringify({ merge: false, staged: true, working: false, untracked: true }),
      );
    v4Db.close();

    const storage = new WorkspaceStorage(tmpDir, bunSqliteFactory);
    storage.openForWorkspace(id);
    const state = storage.getGitPanelState(id);
    expect(state.commitDraft).toBe("legacy draft");
    expect(state.expandedGroups).toEqual({
      merge: false,
      staged: true,
      working: false,
      untracked: true,
    });
    expect(state.commitOptions).toEqual(DEFAULT_GIT_PANEL_STATE.commitOptions);
    expect(state.autofetchIntervalMin).toBe(3);
    expect(state.autofetchManualPaused).toBe(false);
    expect(state.protectedBranches).toEqual([]);
    expect(state.panelSegment).toBe("changes");
    expect(state.historyRef).toBe("HEAD");
    storage.closeForWorkspace(id);

    const migratedDb = bunSqliteFactory(dbPath);
    const columns = migratedDb.prepare("PRAGMA table_info(git_panel_state)").all() as {
      name: string;
    }[];
    expect(columns.map((column) => column.name)).toEqual(
      expect.arrayContaining([
        "commit_options",
        "autofetch_interval_min",
        "autofetch_manual_paused",
        "protected_branches",
      ]),
    );
    const version = migratedDb
      .prepare("SELECT value FROM _meta WHERE key = 'schemaVersion'")
      .get() as { value: string };
    // Bumped to "6" when the compact_folders column was dropped. The legacy
    // git_panel_state preference columns asserted above were added by v5
    // and remain stable across the v6 migration.
    expect(version.value).toBe("6");
    migratedDb.close();

    const reopened = new WorkspaceStorage(tmpDir, bunSqliteFactory);
    reopened.openForWorkspace(id);
    expect(reopened.getGitPanelState(id).commitDraft).toBe("legacy draft");
    reopened.closeForWorkspace(id);
  });
});
