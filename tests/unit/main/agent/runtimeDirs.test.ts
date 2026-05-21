/**
 * Unit tests for src/main/infra/agent/runtimeDirs.ts.
 *
 * Verifies that root/binDir/socketsDir produce consistent absolute paths
 * under the user's home directory, and that ensureDir creates directories
 * with 0o700 permissions idempotently.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fsSync from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { binDir, ensureDir, root, socketsDir } from "../../../../src/main/infra/agent/runtimeDirs";

describe("root", () => {
  test("returns path ending with .nexus-code under home directory", () => {
    const result = root();
    const home = os.homedir();
    expect(result).toBe(path.join(home, ".nexus-code"));
    expect(path.isAbsolute(result)).toBe(true);
  });
});

describe("binDir", () => {
  test("is root()/bin", () => {
    expect(binDir()).toBe(path.join(root(), "bin"));
    expect(path.isAbsolute(binDir())).toBe(true);
  });

  test("is prefixed by root()", () => {
    expect(binDir().startsWith(root())).toBe(true);
  });
});

describe("socketsDir", () => {
  test("is root()/sockets", () => {
    expect(socketsDir()).toBe(path.join(root(), "sockets"));
    expect(path.isAbsolute(socketsDir())).toBe(true);
  });

  test("is prefixed by root()", () => {
    expect(socketsDir().startsWith(root())).toBe(true);
  });
});

describe("ensureDir", () => {
  let tmpBase: string;

  beforeEach(async () => {
    tmpBase = await fsp.mkdtemp(path.join(os.tmpdir(), "runtimedirs-test-"));
  });

  afterEach(async () => {
    await fsp.rm(tmpBase, { recursive: true, force: true });
  });

  test("creates nested directories that do not exist", async () => {
    const target = path.join(tmpBase, "a", "b", "c");
    await ensureDir(target);

    const stat = fsSync.statSync(target);
    expect(stat.isDirectory()).toBe(true);
  });

  test("creates directory with 0o700 permissions", async () => {
    const target = path.join(tmpBase, "secure");
    await ensureDir(target);

    const stat = fsSync.statSync(target);
    const perm = stat.mode & 0o777;
    expect(perm).toBe(0o700);
  });

  test("is idempotent — calling twice on the same path does not throw", async () => {
    const target = path.join(tmpBase, "repeat");
    await ensureDir(target);
    await expect(ensureDir(target)).resolves.toBeUndefined();
  });

  test("succeeds when path already exists as a directory", async () => {
    // tmpBase itself already exists.
    await expect(ensureDir(tmpBase)).resolves.toBeUndefined();
  });
});
