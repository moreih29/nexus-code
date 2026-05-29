/**
 * WorkspaceStorage — origin_permissions accessor round-trip tests.
 *
 * Covers: getOriginPermission, setOriginPermission, listOriginPermissions,
 * deleteOriginPermission, clearOrigin.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WorkspaceStorage } from "../../../../src/main/infra/storage/workspace-storage";

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "nexus-origin-perm-test-"));
}

function bunSqliteFactory(dbPath: string): Database {
  return new Database(dbPath);
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
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns null when no decision has been saved", () => {
    const result = storage.getOriginPermission(id, "https://example.com", "geolocation");
    expect(result).toBeNull();
  });

  it("round-trips an allow decision", () => {
    storage.setOriginPermission(id, "https://example.com", "geolocation", "allow");
    const result = storage.getOriginPermission(id, "https://example.com", "geolocation");
    expect(result).toBe("allow");
  });

  it("round-trips a block decision", () => {
    storage.setOriginPermission(id, "https://example.com", "notifications", "block");
    const result = storage.getOriginPermission(id, "https://example.com", "notifications");
    expect(result).toBe("block");
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
// listOriginPermissions
// ---------------------------------------------------------------------------

describe("WorkspaceStorage.listOriginPermissions", () => {
  let tmpDir: string;
  let storage: WorkspaceStorage;
  const id = "00000000-0000-0000-0000-000000000051";

  beforeEach(() => {
    tmpDir = makeTmpDir();
    storage = new WorkspaceStorage(tmpDir, bunSqliteFactory);
    storage.openForWorkspace(id);
  });

  afterEach(() => {
    storage.closeForWorkspace(id);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns empty array when no permissions saved", () => {
    const rows = storage.listOriginPermissions(id);
    expect(rows).toEqual([]);
  });

  it("returns all saved rows", () => {
    storage.setOriginPermission(id, "https://example.com", "geolocation", "allow");
    storage.setOriginPermission(id, "https://example.com", "notifications", "block");
    storage.setOriginPermission(id, "https://other.com", "media", "allow");

    const rows = storage.listOriginPermissions(id);
    expect(rows.length).toBe(3);

    const geo = rows.find(
      (r) => r.origin === "https://example.com" && r.permission === "geolocation",
    );
    expect(geo?.decision).toBe("allow");

    const notif = rows.find(
      (r) => r.origin === "https://example.com" && r.permission === "notifications",
    );
    expect(notif?.decision).toBe("block");

    const media = rows.find(
      (r) => r.origin === "https://other.com" && r.permission === "media",
    );
    expect(media?.decision).toBe("allow");
  });
});

// ---------------------------------------------------------------------------
// deleteOriginPermission
// ---------------------------------------------------------------------------

describe("WorkspaceStorage.deleteOriginPermission", () => {
  let tmpDir: string;
  let storage: WorkspaceStorage;
  const id = "00000000-0000-0000-0000-000000000052";

  beforeEach(() => {
    tmpDir = makeTmpDir();
    storage = new WorkspaceStorage(tmpDir, bunSqliteFactory);
    storage.openForWorkspace(id);
  });

  afterEach(() => {
    storage.closeForWorkspace(id);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("deleteOriginPermission removes the target row", () => {
    storage.setOriginPermission(id, "https://example.com", "geolocation", "allow");
    storage.setOriginPermission(id, "https://example.com", "notifications", "block");

    storage.deleteOriginPermission(id, "https://example.com", "geolocation");

    expect(storage.getOriginPermission(id, "https://example.com", "geolocation")).toBeNull();
    // other permission unaffected
    expect(storage.getOriginPermission(id, "https://example.com", "notifications")).toBe("block");
  });

  it("deleteOriginPermission is a no-op when row does not exist", () => {
    // Should not throw
    expect(() =>
      storage.deleteOriginPermission(id, "https://example.com", "media"),
    ).not.toThrow();
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

  it("clearOrigin is a no-op when origin has no rows", () => {
    expect(() => storage.clearOrigin(id, "https://unknown.com")).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Error guard — workspace not open
// ---------------------------------------------------------------------------

describe("WorkspaceStorage.origin_permissions — error when workspace not open", () => {
  let tmpDir: string;
  let storage: WorkspaceStorage;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    storage = new WorkspaceStorage(tmpDir, bunSqliteFactory);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const closedId = "00000000-0000-0000-0000-999999999998";

  it("getOriginPermission throws when workspace not open", () => {
    expect(() =>
      storage.getOriginPermission(closedId, "https://example.com", "geolocation"),
    ).toThrow("workspace storage not open");
  });

  it("setOriginPermission throws when workspace not open", () => {
    expect(() =>
      storage.setOriginPermission(closedId, "https://example.com", "geolocation", "allow"),
    ).toThrow("workspace storage not open");
  });

  it("listOriginPermissions throws when workspace not open", () => {
    expect(() => storage.listOriginPermissions(closedId)).toThrow("workspace storage not open");
  });

  it("deleteOriginPermission throws when workspace not open", () => {
    expect(() =>
      storage.deleteOriginPermission(closedId, "https://example.com", "geolocation"),
    ).toThrow("workspace storage not open");
  });

  it("clearOrigin throws when workspace not open", () => {
    expect(() => storage.clearOrigin(closedId, "https://example.com")).toThrow(
      "workspace storage not open",
    );
  });
});
