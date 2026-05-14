/**
 * WorkspaceStorage — panel_view_options round-trip + edge cases.
 *
 * (c) set→get round-trip, missing-row default fallback, different panelKind values.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WorkspaceStorage } from "../../../../src/main/infra/storage/workspace-storage";
import { DEFAULT_VIEW_OPTIONS_BY_PANEL } from "../../../../src/shared/types/panel";

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "nexus-panel-view-test-"));
}

function bunSqliteFactory(dbPath: string): Database {
  return new Database(dbPath);
}

// ---------------------------------------------------------------------------
// (c-1) set → get round-trip for search panel
// ---------------------------------------------------------------------------

describe("WorkspaceStorage.getPanelViewOptions / setPanelViewOptions — search panel", () => {
  let tmpDir: string;
  let storage: WorkspaceStorage;
  const id = "00000000-0000-0000-0000-000000000040";

  beforeEach(() => {
    tmpDir = makeTmpDir();
    storage = new WorkspaceStorage(tmpDir, bunSqliteFactory);
    storage.openForWorkspace(id);
  });

  afterEach(() => {
    storage.closeForWorkspace(id);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("getPanelViewOptions returns search defaults when row is absent", () => {
    const opts = storage.getPanelViewOptions(id, "search");
    expect(opts.viewMode).toBe(DEFAULT_VIEW_OPTIONS_BY_PANEL.search.viewMode);
    expect(opts.compactFolders).toBe(DEFAULT_VIEW_OPTIONS_BY_PANEL.search.compactFolders);
  });

  it("setPanelViewOptions + getPanelViewOptions round-trips viewMode for search", () => {
    storage.setPanelViewOptions(id, "search", { viewMode: "tree" });
    const opts = storage.getPanelViewOptions(id, "search");
    expect(opts.viewMode).toBe("tree");
    // compactFolders should still be default
    expect(opts.compactFolders).toBe(DEFAULT_VIEW_OPTIONS_BY_PANEL.search.compactFolders);
  });

  it("setPanelViewOptions + getPanelViewOptions round-trips compactFolders for search", () => {
    storage.setPanelViewOptions(id, "search", { compactFolders: true });
    const opts = storage.getPanelViewOptions(id, "search");
    expect(opts.compactFolders).toBe(true);
    // viewMode should default to search default
    expect(opts.viewMode).toBe(DEFAULT_VIEW_OPTIONS_BY_PANEL.search.viewMode);
  });

  it("setPanelViewOptions writes both fields atomically", () => {
    storage.setPanelViewOptions(id, "search", { viewMode: "tree", compactFolders: true });
    const opts = storage.getPanelViewOptions(id, "search");
    expect(opts.viewMode).toBe("tree");
    expect(opts.compactFolders).toBe(true);
  });

  it("second setPanelViewOptions call overwrites first", () => {
    storage.setPanelViewOptions(id, "search", { viewMode: "tree", compactFolders: true });
    storage.setPanelViewOptions(id, "search", { viewMode: "list", compactFolders: false });
    const opts = storage.getPanelViewOptions(id, "search");
    expect(opts.viewMode).toBe("list");
    expect(opts.compactFolders).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// (c-2) git panel kind is independent from search
// ---------------------------------------------------------------------------

describe("WorkspaceStorage.getPanelViewOptions — git panel defaults and isolation", () => {
  let tmpDir: string;
  let storage: WorkspaceStorage;
  const id = "00000000-0000-0000-0000-000000000041";

  beforeEach(() => {
    tmpDir = makeTmpDir();
    storage = new WorkspaceStorage(tmpDir, bunSqliteFactory);
    storage.openForWorkspace(id);
  });

  afterEach(() => {
    storage.closeForWorkspace(id);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("getPanelViewOptions returns git defaults when row is absent", () => {
    const opts = storage.getPanelViewOptions(id, "git");
    expect(opts.viewMode).toBe(DEFAULT_VIEW_OPTIONS_BY_PANEL.git.viewMode);
    expect(opts.compactFolders).toBe(DEFAULT_VIEW_OPTIONS_BY_PANEL.git.compactFolders);
  });

  it("search and git panel options are stored independently", () => {
    storage.setPanelViewOptions(id, "search", { viewMode: "tree", compactFolders: true });
    storage.setPanelViewOptions(id, "git", { viewMode: "list", compactFolders: false });

    const searchOpts = storage.getPanelViewOptions(id, "search");
    const gitOpts = storage.getPanelViewOptions(id, "git");

    expect(searchOpts.viewMode).toBe("tree");
    expect(searchOpts.compactFolders).toBe(true);
    expect(gitOpts.viewMode).toBe("list");
    expect(gitOpts.compactFolders).toBe(false);
  });

  it("setPanelViewOptions for git round-trips viewMode=tree", () => {
    storage.setPanelViewOptions(id, "git", { viewMode: "tree" });
    const opts = storage.getPanelViewOptions(id, "git");
    expect(opts.viewMode).toBe("tree");
  });
});

// ---------------------------------------------------------------------------
// (c-3) partial update merges correctly (only viewMode changed, compactFolders kept)
// ---------------------------------------------------------------------------

describe("WorkspaceStorage.setPanelViewOptions — partial merge", () => {
  let tmpDir: string;
  let storage: WorkspaceStorage;
  const id = "00000000-0000-0000-0000-000000000042";

  beforeEach(() => {
    tmpDir = makeTmpDir();
    storage = new WorkspaceStorage(tmpDir, bunSqliteFactory);
    storage.openForWorkspace(id);
  });

  afterEach(() => {
    storage.closeForWorkspace(id);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("partial viewMode update preserves existing compactFolders", () => {
    // First write sets both fields.
    storage.setPanelViewOptions(id, "search", { viewMode: "tree", compactFolders: true });
    // Second write changes only viewMode.
    storage.setPanelViewOptions(id, "search", { viewMode: "list" });

    const opts = storage.getPanelViewOptions(id, "search");
    expect(opts.viewMode).toBe("list");
    expect(opts.compactFolders).toBe(true); // preserved
  });

  it("partial compactFolders update preserves existing viewMode", () => {
    storage.setPanelViewOptions(id, "search", { viewMode: "tree", compactFolders: false });
    storage.setPanelViewOptions(id, "search", { compactFolders: true });

    const opts = storage.getPanelViewOptions(id, "search");
    expect(opts.viewMode).toBe("tree"); // preserved
    expect(opts.compactFolders).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// (c-4) getPanelViewOptions throws when workspace not open
// ---------------------------------------------------------------------------

describe("WorkspaceStorage.getPanelViewOptions — error when not open", () => {
  let tmpDir: string;
  let storage: WorkspaceStorage;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    storage = new WorkspaceStorage(tmpDir, bunSqliteFactory);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("getPanelViewOptions throws when workspace is not open", () => {
    expect(() =>
      storage.getPanelViewOptions("00000000-0000-0000-0000-999999999999", "search"),
    ).toThrow("workspace storage not open");
  });

  it("setPanelViewOptions throws when workspace is not open", () => {
    expect(() =>
      storage.setPanelViewOptions("00000000-0000-0000-0000-999999999999", "git", {
        viewMode: "tree",
      }),
    ).toThrow("workspace storage not open");
  });
});
