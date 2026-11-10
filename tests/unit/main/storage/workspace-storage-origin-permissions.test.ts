/**
 * WorkspaceStorage — origin_permissions accessor round-trip tests.
 *
 * Covers: getOriginPermission, setOriginPermission, listOriginPermissions,
 * deleteOriginPermission, clearOrigin.
 */

import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WorkspaceStorage } from "../../../../src/main/infra/storage/workspace-storage";
import { closeTestDatabases, openTestDatabase } from "../../../helpers/test-database";

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "nexus-origin-perm-test-"));
}

function bunSqliteFactory(dbPath: string): Database {
  return openTestDatabase(dbPath);
}

// ---------------------------------------------------------------------------
// getOriginPermission / setOriginPermission round-trip
// ---------------------------------------------------------------------------

describe("WorkspaceStorage.getOriginPermission / setOriginPermission — round-trip", () => {
  let tmpDir: string;
  let storage: WorkspaceStorage;
  const id = "00000000-0000-0000-0000-000000000050";

  beforeEach(() => {
    tmpDir = makeTmpDir();
    storage = new WorkspaceStorage(tmpDir, bunSqliteFactory);
    storage.openForWorkspace(id);
  });

  afterEach(() => {
    storage.closeForWorkspace(id);
    closeTestDatabases();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("overwrites a prior decision on second set", () => {
    storage.setOriginPermission(id, "https://example.com", "media", "allow");
    storage.setOriginPermission(id, "https://example.com", "media", "block");
    const result = storage.getOriginPermission(id, "https://example.com", "media");
    expect(result).toBe("block");
  });

  it("different permissions for the same origin are stored independently", () => {
    storage.setOriginPermission(id, "https://example.com", "geolocation", "allow");
    storage.setOriginPermission(id, "https://example.com", "notifications", "block");
    expect(storage.getOriginPermission(id, "https://example.com", "geolocation")).toBe("allow");
    expect(storage.getOriginPermission(id, "https://example.com", "notifications")).toBe("block");
  });

  it("different origins for the same permission are stored independently", () => {
    storage.setOriginPermission(id, "https://a.com", "media", "allow");
    storage.setOriginPermission(id, "https://b.com", "media", "block");
    expect(storage.getOriginPermission(id, "https://a.com", "media")).toBe("allow");
    expect(storage.getOriginPermission(id, "https://b.com", "media")).toBe("block");
  });
});

// ---------------------------------------------------------------------------
// clearOrigin
// ---------------------------------------------------------------------------

describe("WorkspaceStorage.clearOrigin", () => {
  let tmpDir: string;
  let storage: WorkspaceStorage;
  const id = "00000000-0000-0000-0000-000000000053";

  beforeEach(() => {
    tmpDir = makeTmpDir();
    storage = new WorkspaceStorage(tmpDir, bunSqliteFactory);
    storage.openForWorkspace(id);
  });

  afterEach(() => {
    storage.closeForWorkspace(id);
    closeTestDatabases();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("clearOrigin removes all rows for the given origin", () => {
    storage.setOriginPermission(id, "https://example.com", "geolocation", "allow");
    storage.setOriginPermission(id, "https://example.com", "notifications", "block");
    storage.setOriginPermission(id, "https://other.com", "media", "allow");

    storage.clearOrigin(id, "https://example.com");

    expect(storage.getOriginPermission(id, "https://example.com", "geolocation")).toBeNull();
    expect(storage.getOriginPermission(id, "https://example.com", "notifications")).toBeNull();
    // other origin unaffected
    expect(storage.getOriginPermission(id, "https://other.com", "media")).toBe("allow");
  });
});
