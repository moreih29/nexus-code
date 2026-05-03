/**
 * Security regression tests for src/main/ipc/channels/fs.ts
 *
 * Tests resolveSafe() path-escape guards and readdirHandler() filter behavior
 * using minimal duck-typed WorkspaceManager mocks — no real manager import.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  getExpandedHandler,
  readdirHandler,
  resolveSafe,
  setExpandedHandler,
} from "../../src/main/ipc/channels/fs";
import type { WorkspaceMeta } from "../../src/shared/types/workspace";

// ---------------------------------------------------------------------------
// Minimal duck-typed manager helper
// ---------------------------------------------------------------------------

const VALID_UUID = "123e4567-e89b-12d3-a456-426614174000";

function makeManager(rootPath: string): { list: () => WorkspaceMeta[] } {
  return {
    list: () => [
      {
        id: VALID_UUID,
        name: "test-workspace",
        rootPath,
        colorTone: "default",
        pinned: false,
        lastOpenedAt: new Date().toISOString(),
        tabs: [],
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Tmp dir lifecycle
// ---------------------------------------------------------------------------

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-fs-test-"));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helper: build a readdirHandler handler that reads args the same way the
// real IPC call would — wraps the returned function with a plain object arg.
// ---------------------------------------------------------------------------

function callReaddir(
  manager: { list: () => WorkspaceMeta[] },
  workspaceId: string,
  relPath: string,
) {
  // readdirHandler returns an (args: unknown) => Promise<DirEntry[]> function.
  // We supply the args the same way the router would.
  const handler = readdirHandler(manager as never);
  return handler({ workspaceId, relPath });
}

// ---------------------------------------------------------------------------
// Scenario 1: readdir root — length and entry shape
// ---------------------------------------------------------------------------

describe("readdir — root (relPath: '')", () => {
  it("returns entries whose shape has name and type", async () => {
    // Create one visible file so the root listing is non-trivial.
    fs.writeFileSync(path.join(tmpRoot, "hello.txt"), "hi");

    const entries = await callReaddir(makeManager(tmpRoot), VALID_UUID, "");

    expect(entries.length).toBeGreaterThanOrEqual(1);
    for (const e of entries) {
      expect(typeof e.name).toBe("string");
      expect(["file", "dir", "symlink"]).toContain(e.type);
    }
  });
});

// ---------------------------------------------------------------------------
// Scenario 2: readdir subdir — children returned
// ---------------------------------------------------------------------------

describe("readdir — subdir (relPath: 'subdir')", () => {
  it("returns children of the subdirectory", async () => {
    const sub = path.join(tmpRoot, "subdir");
    fs.mkdirSync(sub);
    fs.writeFileSync(path.join(sub, "child.ts"), "");

    const entries = await callReaddir(makeManager(tmpRoot), VALID_UUID, "subdir");

    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe("child.ts");
    expect(entries[0].type).toBe("file");
  });
});

// ---------------------------------------------------------------------------
// Scenario 3: path traversal via '../etc'
// ---------------------------------------------------------------------------

describe("resolveSafe — path traversal '../etc'", () => {
  it("throws when relPath escapes workspace root", () => {
    expect(() => resolveSafe(makeManager(tmpRoot) as never, VALID_UUID, "../etc")).toThrow(
      "path escapes workspace root",
    );
  });
});

// ---------------------------------------------------------------------------
// Scenario 4: absolute path
// ---------------------------------------------------------------------------

describe("resolveSafe — absolute relPath", () => {
  it("throws when relPath is absolute and outside root", () => {
    // path.resolve(root, '/absolute/path') === '/absolute/path', which is outside root
    expect(() => resolveSafe(makeManager(tmpRoot) as never, VALID_UUID, "/absolute/path")).toThrow(
      "path escapes workspace root",
    );
  });
});

// ---------------------------------------------------------------------------
// Scenario 5: double traversal 'sub/../../etc'
// ---------------------------------------------------------------------------

describe("resolveSafe — normalized double traversal 'sub/../../etc'", () => {
  it("throws after path.resolve normalizes the segments", () => {
    expect(() => resolveSafe(makeManager(tmpRoot) as never, VALID_UUID, "sub/../../etc")).toThrow(
      "path escapes workspace root",
    );
  });
});

// ---------------------------------------------------------------------------
// Scenario 6: unknown workspaceId
// ---------------------------------------------------------------------------

describe("resolveSafe — unknown workspaceId", () => {
  it("throws 'workspace not found' when workspaceId is not registered", () => {
    const unknownId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    expect(() => resolveSafe(makeManager(tmpRoot) as never, unknownId, "")).toThrow(
      "workspace not found",
    );
  });
});

// ---------------------------------------------------------------------------
// Scenario 7: HIDDEN_NAMES (.git, node_modules) are filtered out
// ---------------------------------------------------------------------------

describe("readdir — HIDDEN_NAMES filtered", () => {
  it("excludes .git and node_modules from listing", async () => {
    // Create hidden dirs and a visible file
    fs.mkdirSync(path.join(tmpRoot, ".git"));
    fs.mkdirSync(path.join(tmpRoot, "node_modules"));
    fs.writeFileSync(path.join(tmpRoot, "index.ts"), "");

    const entries = await callReaddir(makeManager(tmpRoot), VALID_UUID, "");
    const names = entries.map((e) => e.name);

    expect(names).not.toContain(".git");
    expect(names).not.toContain("node_modules");
    expect(names).toContain("index.ts");
  });
});

// ---------------------------------------------------------------------------
// Scenario 8: dotfile not in HIDDEN_NAMES is included
// ---------------------------------------------------------------------------

describe("readdir — dotfile not in HIDDEN_NAMES is included", () => {
  it("includes .env in the listing", async () => {
    fs.writeFileSync(path.join(tmpRoot, ".env"), "SECRET=x");

    const entries = await callReaddir(makeManager(tmpRoot), VALID_UUID, "");
    const names = entries.map((e) => e.name);

    expect(names).toContain(".env");
  });
});

// ---------------------------------------------------------------------------
// Scenario 9: symlink pointing outside root returns type='symlink', not followed
// ---------------------------------------------------------------------------

describe("readdir — out-of-root symlink returned as type='symlink'", () => {
  it("reports symlink entry with type='symlink' without following target", async () => {
    // Create a symlink that points to a path outside the workspace root.
    const outsideTarget = os.tmpdir(); // guaranteed to exist and be outside tmpRoot
    const linkPath = path.join(tmpRoot, "outside-link");
    fs.symlinkSync(outsideTarget, linkPath);

    const entries = await callReaddir(makeManager(tmpRoot), VALID_UUID, "");
    const linkEntry = entries.find((e) => e.name === "outside-link");

    expect(linkEntry).toBeDefined();
    expect(linkEntry?.type).toBe("symlink");
  });
});

// ---------------------------------------------------------------------------
// Scenario 10: getExpandedHandler — delegates to WorkspaceStorage
// ---------------------------------------------------------------------------

describe("getExpandedHandler", () => {
  it("returns relPaths from storage.getExpandedPaths", async () => {
    const mockStorage = {
      getExpandedPaths: (_id: string) => ["src", "src/components"],
      setExpandedPaths: () => {},
    };
    const handler = getExpandedHandler(mockStorage as never);
    const result = await handler({ workspaceId: VALID_UUID });
    expect(result).toEqual({ relPaths: ["src", "src/components"] });
  });

  it("rejects when workspaceId is not a valid UUID", async () => {
    const mockStorage = { getExpandedPaths: () => [], setExpandedPaths: () => {} };
    const handler = getExpandedHandler(mockStorage as never);
    await expect(handler({ workspaceId: "not-a-uuid" })).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Scenario 11: setExpandedHandler — delegates to WorkspaceStorage
// ---------------------------------------------------------------------------

describe("setExpandedHandler", () => {
  it("calls storage.setExpandedPaths with the provided relPaths", async () => {
    let capturedId = "";
    let capturedPaths: string[] = [];
    const mockStorage = {
      getExpandedPaths: () => [],
      setExpandedPaths: (id: string, paths: string[]) => {
        capturedId = id;
        capturedPaths = paths;
      },
    };
    const handler = setExpandedHandler(mockStorage as never);
    await handler({ workspaceId: VALID_UUID, relPaths: ["src", "lib"] });
    expect(capturedId).toBe(VALID_UUID);
    expect(capturedPaths).toEqual(["src", "lib"]);
  });

  it("rejects when workspaceId is not a valid UUID", async () => {
    const mockStorage = { getExpandedPaths: () => [], setExpandedPaths: () => {} };
    const handler = setExpandedHandler(mockStorage as never);
    await expect(handler({ workspaceId: "bad", relPaths: [] })).rejects.toThrow();
  });
});
