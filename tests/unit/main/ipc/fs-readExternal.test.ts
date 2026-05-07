/**
 * Unit tests for readExternalHandler.
 *
 * Imports come directly from read-handlers.ts to avoid loading move-handlers.ts,
 * which depends on Electron's shell module (fails under Bun's test runtime).
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readExternalHandler } from "../../../../src/main/ipc/channels/fs/read-handlers";

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-read-external-"));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function callReadExternal(absolutePath: string) {
  const handler = readExternalHandler();
  return handler({ absolutePath });
}

// ---------------------------------------------------------------------------
// Scenario 1: utf-8 plain text
// ---------------------------------------------------------------------------

describe("readExternalHandler — utf-8 plain text", () => {
  it("returns content, encoding=utf8, correct sizeBytes, isBinary=false, and a valid mtime", async () => {
    const filePath = path.join(tmpRoot, "hello.ts");
    const text = "export const x = 42;\n";
    await fs.promises.writeFile(filePath, text, "utf8");

    const result = await callReadExternal(filePath);

    expect(result.content).toBe(text);
    expect(result.encoding).toBe("utf8");
    expect(result.sizeBytes).toBe(Buffer.byteLength(text, "utf8"));
    expect(result.isBinary).toBe(false);
    expect(new Date(result.mtime).getTime()).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Scenario 2: nonexistent path
// ---------------------------------------------------------------------------

describe("readExternalHandler — nonexistent path", () => {
  it("throws with NOT_FOUND prefix", async () => {
    const missing = path.join(tmpRoot, "does-not-exist.ts");
    await expect(callReadExternal(missing)).rejects.toThrow(/^NOT_FOUND:/);
  });
});

// ---------------------------------------------------------------------------
// Scenario 3: binary file
// ---------------------------------------------------------------------------

describe("readExternalHandler — binary file (null bytes)", () => {
  it("returns isBinary=true and content=''", async () => {
    const filePath = path.join(tmpRoot, "binary.bin");
    const buf = Buffer.alloc(64, 0x00);
    await fs.promises.writeFile(filePath, buf);

    const result = await callReadExternal(filePath);

    expect(result.isBinary).toBe(true);
    expect(result.content).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Scenario 4: workspace-internal path also works (path-safety bypass is intentional)
// ---------------------------------------------------------------------------

describe("readExternalHandler — workspace-internal absolute path", () => {
  it("reads successfully without a workspace manager (no path-safety check)", async () => {
    const filePath = path.join(tmpRoot, "internal.ts");
    const text = "// workspace internal file\n";
    await fs.promises.writeFile(filePath, text, "utf8");

    const result = await callReadExternal(filePath);

    expect(result.content).toBe(text);
    expect(result.isBinary).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Scenario 5: relative path throws
// ---------------------------------------------------------------------------

describe("readExternalHandler — relative path", () => {
  it("throws when absolutePath is not absolute", async () => {
    await expect(callReadExternal("relative/path/file.ts")).rejects.toThrow(
      /path must be absolute/,
    );
  });
});

// ---------------------------------------------------------------------------
// Scenario 6: EACCES throws PERMISSION_DENIED
// ---------------------------------------------------------------------------

describe("readExternalHandler — EACCES (permission denied)", () => {
  it("throws with PERMISSION_DENIED prefix", async () => {
    if (process.getuid?.() === 0) {
      return;
    }
    const filePath = path.join(tmpRoot, "secret.ts");
    await fs.promises.writeFile(filePath, "secret");
    await fs.promises.chmod(filePath, 0o000);

    try {
      await expect(callReadExternal(filePath)).rejects.toThrow(/^PERMISSION_DENIED:/);
    } finally {
      await fs.promises.chmod(filePath, 0o644);
    }
  });
});

// ---------------------------------------------------------------------------
// Scenario 7: file too large
// ---------------------------------------------------------------------------

describe("readExternalHandler — file exceeds MAX_READABLE_FILE_SIZE", () => {
  it("throws with TOO_LARGE prefix", async () => {
    const filePath = path.join(tmpRoot, "big.bin");
    const buf = Buffer.alloc(6 * 1024 * 1024 + 1, "x".charCodeAt(0));
    await fs.promises.writeFile(filePath, buf);

    await expect(callReadExternal(filePath)).rejects.toThrow(/^TOO_LARGE:/);
  });
});
