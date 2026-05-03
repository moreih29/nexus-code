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
  readFileHandler,
  resolveSafe,
  setExpandedHandler,
} from "../../../../src/main/ipc/channels/fs";
import type { WorkspaceMeta } from "../../../../src/shared/types/workspace";

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
    const handler = getExpandedHandler(makeManager(tmpRoot) as never, mockStorage as never);
    const result = await handler({ workspaceId: VALID_UUID });
    expect(result).toEqual({ relPaths: ["src", "src/components"] });
  });

  it("rejects when workspaceId is not a valid UUID", async () => {
    const mockStorage = { getExpandedPaths: () => [], setExpandedPaths: () => {} };
    const handler = getExpandedHandler(makeManager(tmpRoot) as never, mockStorage as never);
    await expect(handler({ workspaceId: "not-a-uuid" })).rejects.toThrow();
  });

  it("throws 'workspace not found' when workspaceId is a valid UUID not in manager", async () => {
    const unknownId = "ffffffff-ffff-ffff-ffff-ffffffffffff";
    const mockStorage = { getExpandedPaths: () => [], setExpandedPaths: () => {} };
    const handler = getExpandedHandler(makeManager(tmpRoot) as never, mockStorage as never);
    await expect(handler({ workspaceId: unknownId })).rejects.toThrow("workspace not found");
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
    const handler = setExpandedHandler(makeManager(tmpRoot) as never, mockStorage as never);
    await handler({ workspaceId: VALID_UUID, relPaths: ["src", "lib"] });
    expect(capturedId).toBe(VALID_UUID);
    expect(capturedPaths).toEqual(["src", "lib"]);
  });

  it("rejects when workspaceId is not a valid UUID", async () => {
    const mockStorage = { getExpandedPaths: () => [], setExpandedPaths: () => {} };
    const handler = setExpandedHandler(makeManager(tmpRoot) as never, mockStorage as never);
    await expect(handler({ workspaceId: "bad", relPaths: [] })).rejects.toThrow();
  });

  it("throws 'workspace not found' when workspaceId is a valid UUID not in manager", async () => {
    const unknownId = "ffffffff-ffff-ffff-ffff-ffffffffffff";
    const mockStorage = { getExpandedPaths: () => [], setExpandedPaths: () => {} };
    const handler = setExpandedHandler(makeManager(tmpRoot) as never, mockStorage as never);
    await expect(handler({ workspaceId: unknownId, relPaths: [] })).rejects.toThrow(
      "workspace not found",
    );
  });
});

// ---------------------------------------------------------------------------
// readFileHandler
// ---------------------------------------------------------------------------

function callReadFile(
  manager: { list: () => WorkspaceMeta[] },
  workspaceId: string,
  relPath: string,
) {
  const handler = readFileHandler(manager as never);
  return handler({ workspaceId, relPath });
}

describe("readFileHandler — utf-8 plain text", () => {
  it("returns content, encoding=utf8, correct sizeBytes, isBinary=false", async () => {
    const filePath = path.join(tmpRoot, "plain.ts");
    const text = "export const x = 1;\n";
    await fs.promises.writeFile(filePath, text, "utf8");

    const result = await callReadFile(makeManager(tmpRoot), VALID_UUID, "plain.ts");

    expect(result.content).toBe(text);
    expect(result.encoding).toBe("utf8");
    expect(result.sizeBytes).toBe(Buffer.byteLength(text, "utf8"));
    expect(result.isBinary).toBe(false);
  });
});

describe("readFileHandler — utf-8 BOM file", () => {
  it("strips BOM and returns encoding=utf8-bom", async () => {
    const filePath = path.join(tmpRoot, "bom.ts");
    const text = "const a = 1;";
    const bom = Buffer.from([0xef, 0xbb, 0xbf]);
    await fs.promises.writeFile(filePath, Buffer.concat([bom, Buffer.from(text, "utf8")]));

    const result = await callReadFile(makeManager(tmpRoot), VALID_UUID, "bom.ts");

    expect(result.encoding).toBe("utf8-bom");
    expect(result.content).toBe(text);
    expect(result.isBinary).toBe(false);
  });
});

describe("readFileHandler — 6MB file exceeds limit", () => {
  it("throws with TOO_LARGE prefix", async () => {
    const filePath = path.join(tmpRoot, "big.bin");
    const buf = Buffer.alloc(6 * 1024 * 1024 + 1, "x".charCodeAt(0));
    await fs.promises.writeFile(filePath, buf);

    await expect(callReadFile(makeManager(tmpRoot), VALID_UUID, "big.bin")).rejects.toThrow(
      /^TOO_LARGE:/,
    );
  });
});

describe("readFileHandler — path is a directory", () => {
  it("throws with IS_DIRECTORY prefix", async () => {
    fs.mkdirSync(path.join(tmpRoot, "adir"));

    await expect(callReadFile(makeManager(tmpRoot), VALID_UUID, "adir")).rejects.toThrow(
      /^IS_DIRECTORY:/,
    );
  });
});

describe("readFileHandler — non-existent file", () => {
  it("throws with NOT_FOUND prefix", async () => {
    await expect(
      callReadFile(makeManager(tmpRoot), VALID_UUID, "no-such-file.ts"),
    ).rejects.toThrow(/^NOT_FOUND:/);
  });
});

describe("readFileHandler — EACCES (permission denied)", () => {
  it("throws with PERMISSION_DENIED prefix", async () => {
    if (process.getuid?.() === 0) {
      // root can read any file regardless of permissions
      return;
    }
    const filePath = path.join(tmpRoot, "secret.ts");
    await fs.promises.writeFile(filePath, "secret");
    await fs.promises.chmod(filePath, 0o000);

    try {
      await expect(callReadFile(makeManager(tmpRoot), VALID_UUID, "secret.ts")).rejects.toThrow(
        /^PERMISSION_DENIED:/,
      );
    } finally {
      await fs.promises.chmod(filePath, 0o644);
    }
  });
});

describe("readFileHandler — null byte binary detection", () => {
  it("returns isBinary=true and content='' when first 512 bytes contain 0x00", async () => {
    const filePath = path.join(tmpRoot, "binary.bin");
    const buf = Buffer.alloc(512, 0x00);
    await fs.promises.writeFile(filePath, buf);

    const result = await callReadFile(makeManager(tmpRoot), VALID_UUID, "binary.bin");

    expect(result.isBinary).toBe(true);
    expect(result.content).toBe("");
  });
});

describe("readFileHandler — UTF-16 LE BOM", () => {
  it("returns isBinary=true for UTF-16 LE BOM file", async () => {
    const filePath = path.join(tmpRoot, "utf16le.txt");
    const buf = Buffer.from([0xff, 0xfe, 0x68, 0x00, 0x69, 0x00]); // LE BOM + "hi"
    await fs.promises.writeFile(filePath, buf);

    const result = await callReadFile(makeManager(tmpRoot), VALID_UUID, "utf16le.txt");

    expect(result.isBinary).toBe(true);
    expect(result.content).toBe("");
  });
});

describe("readFileHandler — path traversal '../foo'", () => {
  it("throws before reaching disk when relPath escapes workspace root", async () => {
    await expect(callReadFile(makeManager(tmpRoot), VALID_UUID, "../foo")).rejects.toThrow(
      "path escapes workspace root",
    );
  });
});
