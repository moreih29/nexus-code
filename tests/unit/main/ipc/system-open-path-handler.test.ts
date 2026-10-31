/**
 * system.openPathExternal / system.revealInOS handler tests.
 *
 * These handlers are workspace-agnostic and return typed result objects
 * instead of throwing for missing paths, so tests exercise the real filesystem
 * preflight plus injected shell stubs.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  openPathExternalHandler,
  revealInOSHandler,
} from "../../../../src/main/features/shell/open-path";
import { ipcContract } from "../../../../src/shared/ipc/contract";

const openPathResult = ipcContract.system.call.openPathExternal.result;

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "nexus-system-ipc-"));
}

describe("system path handlers", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("opens an existing path with Electron shell.openPath", async () => {
    const filePath = path.join(tmpDir, "readme.md");
    fs.writeFileSync(filePath, "# hi\n");
    const shell = {
      openPath: mock(async (_absPath: string) => ""),
      showItemInFolder: mock((_absPath: string) => {}),
    };

    const result = await openPathExternalHandler(shell)({ absPath: filePath });

    expect(result).toEqual({ ok: true });
    expect(openPathResult.safeParse(result).success).toBe(true);
    expect(shell.openPath).toHaveBeenCalledWith(filePath);
  });

  it("returns a typed not-found error for nonexistent paths", async () => {
    const missingPath = path.join(tmpDir, "missing.txt");
    const shell = {
      openPath: mock(async (_absPath: string) => ""),
      showItemInFolder: mock((_absPath: string) => {}),
    };

    const result = await openPathExternalHandler(shell)({ absPath: missingPath });

    expect(result).toEqual({
      ok: false,
      error: { code: "not-found", message: "Path does not exist.", absPath: missingPath },
    });
    expect(openPathResult.safeParse(result).success).toBe(true);
    expect(shell.openPath).not.toHaveBeenCalled();
  });

  it("reveals an existing path with Electron shell.showItemInFolder", async () => {
    const filePath = path.join(tmpDir, "visible.txt");
    fs.writeFileSync(filePath, "visible");
    const shell = { showItemInFolder: mock((_absPath: string) => {}) };

    const result = await revealInOSHandler(shell)({ absPath: filePath });

    expect(result).toEqual({ ok: true });
    expect(shell.showItemInFolder).toHaveBeenCalledWith(filePath);
  });
});
