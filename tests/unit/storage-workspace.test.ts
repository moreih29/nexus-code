import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WorkspaceStorage } from "../../src/main/storage/workspaceStorage";
import type { WorkspaceMeta } from "../../src/shared/types/workspace";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "nexus-wsstorage-test-"));
}

function makeMeta(id: string): WorkspaceMeta {
  return {
    id,
    name: "my-workspace",
    rootPath: path.join(os.tmpdir(), "ws"),
    colorTone: "default",
    pinned: false,
    category: "DEFAULT",
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

  it("is idempotent — opening the same workspace twice does not throw", () => {
    const id = "00000000-0000-0000-0000-000000000001";
    storage.openForWorkspace(id);
    expect(() => storage.openForWorkspace(id)).not.toThrow();
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

  it("setMeta writes workspace.json recovery dump", () => {
    const meta = makeMeta(id);
    storage.setMeta(id, meta);
    const jsonPath = path.join(tmpDir, id, "workspace.json");
    expect(fs.existsSync(jsonPath)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(jsonPath, "utf8")) as WorkspaceMeta;
    expect(parsed.id).toBe(id);
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

  it("closeForWorkspace on a non-open workspace is a no-op", () => {
    expect(() => storage.closeForWorkspace("00000000-0000-0000-0000-000000000099")).not.toThrow();
  });
});
