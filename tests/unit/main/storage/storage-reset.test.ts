import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WorkspaceStorage } from "../../../../src/main/storage/workspace-storage";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "nexus-reset-test-"));
}

function bunSqliteFactory(dbPath: string): Database {
  return new Database(dbPath);
}

// ---------------------------------------------------------------------------
// NEXUS_RESET_STORAGE=1 tests
//
// NOTE: This behaviour is temporary and should be removed once the
// storage reset UX is formalized.
// ---------------------------------------------------------------------------

describe("NEXUS_RESET_STORAGE=1", () => {
  let tmpDir: string;
  let originalEnv: string | undefined;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    originalEnv = process.env.NEXUS_RESET_STORAGE;
    process.env.NEXUS_RESET_STORAGE = "1";
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.NEXUS_RESET_STORAGE;
    } else {
      process.env.NEXUS_RESET_STORAGE = originalEnv;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("renames existing workspace folder to backup-{ts} and creates a fresh directory", () => {
    const id = "00000000-0000-0000-0000-000000000001";
    const wsDir = path.join(tmpDir, id);

    // Create a pre-existing workspace directory with a marker file.
    fs.mkdirSync(wsDir, { recursive: true });
    fs.writeFileSync(path.join(wsDir, "marker.txt"), "old data");

    const storage = new WorkspaceStorage(tmpDir, bunSqliteFactory);
    storage.openForWorkspace(id);

    // The original directory should no longer have the marker file.
    expect(fs.existsSync(path.join(wsDir, "marker.txt"))).toBe(false);

    // A backup directory should exist.
    const siblings = fs.readdirSync(tmpDir);
    const backups = siblings.filter((name) => name.startsWith("backup-"));
    expect(backups.length).toBe(1);
    expect(fs.existsSync(path.join(tmpDir, backups[0], "marker.txt"))).toBe(true);

    // A fresh workspace directory should exist.
    expect(fs.existsSync(wsDir)).toBe(true);
    expect(fs.existsSync(path.join(wsDir, "state.db"))).toBe(true);

    storage.closeForWorkspace(id);
  });

  it("does not create a backup when the workspace directory does not yet exist", () => {
    const id = "00000000-0000-0000-0000-000000000002";
    const storage = new WorkspaceStorage(tmpDir, bunSqliteFactory);
    storage.openForWorkspace(id);

    const siblings = fs.readdirSync(tmpDir);
    const backups = siblings.filter((name) => name.startsWith("backup-"));
    expect(backups.length).toBe(0);

    storage.closeForWorkspace(id);
  });
});
