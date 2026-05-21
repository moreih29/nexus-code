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
import { execSync } from "node:child_process";
import {
  binDir,
  ensureDir,
  removeShimDir,
  root,
  shimDir,
  socketsDir,
  writeShimFiles,
} from "../../../../src/main/infra/agent/runtimeDirs";

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

// ---------------------------------------------------------------------------
// shimDir / writeShimFiles / removeShimDir
// ---------------------------------------------------------------------------

describe("shimDir", () => {
  test("returns <root>/shim/<workspaceId> as an absolute path", () => {
    const id = "ws-abc123";
    const result = shimDir(id);
    expect(result).toBe(path.join(root(), "shim", id));
    expect(path.isAbsolute(result)).toBe(true);
  });

  test("embeds the workspaceId segment verbatim", () => {
    const id = "my-workspace";
    expect(shimDir(id)).toContain(id);
  });
});

describe("writeShimFiles", () => {
  let tmpBase: string;
  // Monkey-patch root() so shim files land in a temp directory instead of ~/.nexus-code.
  // We do this by temporarily overriding os.homedir via environment variable indirection.
  // A simpler approach: use a real tmpdir and test against direct file system.
  // Since shimDir derives from root() which reads os.homedir(), we use a real tmpdir
  // and verify via the returned paths directly.

  beforeEach(async () => {
    tmpBase = await fsp.mkdtemp(path.join(os.tmpdir(), "shimfiles-test-"));
  });

  afterEach(async () => {
    await fsp.rm(tmpBase, { recursive: true, force: true });
  });

  // Helper: call writeShimFiles but redirect the shim root to tmpBase by
  // writing files under tmpBase/<workspaceId> directly — we test the public API
  // using a workspace ID whose shimDir we override by relying on writeShimFiles
  // internals via the returned paths.
  //
  // Because writeShimFiles calls shimDir internally (which calls root() → HOME),
  // we instead create a synthetic workspaceId that includes enough path segments
  // to land inside tmpBase. We cannot change HOME at runtime reliably in Bun's
  // test runner, so we test writeShimFiles against the real HOME-based shimDir
  // but clean up afterwards.

  let createdShimDir: string;

  afterEach(async () => {
    if (createdShimDir) {
      await fsp.rm(createdShimDir, { recursive: true, force: true });
      createdShimDir = "";
    }
  });

  test("acceptance 1 — returns correct absolute paths", async () => {
    const id = "test-ws-paths-" + Date.now();
    const result = await writeShimFiles(id);
    createdShimDir = result.dir;

    expect(result.dir).toBe(shimDir(id));
    expect(result.zshrc).toBe(path.join(shimDir(id), ".zshrc"));
    expect(result.zshenv).toBe(path.join(shimDir(id), ".zshenv"));
    expect(result.bashrc).toBe(path.join(shimDir(id), "bashrc"));
  });

  test("acceptance 2 — creates 3 files with spec-compliant content", async () => {
    const id = "test-ws-content-" + Date.now();
    const result = await writeShimFiles(id);
    createdShimDir = result.dir;

    const zshrcContent = await fsp.readFile(result.zshrc, "utf-8");
    const zshenvContent = await fsp.readFile(result.zshenv, "utf-8");
    const bashrcContent = await fsp.readFile(result.bashrc, "utf-8");

    // Verify key functional fragments from the spec are present.
    expect(zshrcContent).toContain("NEXUS_USER_ZDOTDIR");
    expect(zshrcContent).toContain("add-zsh-hook precmd _nexus_prepend_wrapper");
    expect(zshrcContent).toContain("_nexus_prepend_wrapper");
    expect(zshrcContent).toContain("NEXUS_WRAPPER_SELF_DIR");

    expect(zshenvContent).toContain("NEXUS_USER_ZDOTDIR");
    expect(zshenvContent).toContain(".zshenv");

    expect(bashrcContent).toContain(".bashrc");
    expect(bashrcContent).toContain("PROMPT_COMMAND");
    expect(bashrcContent).toContain("_nexus_prepend_wrapper");
    expect(bashrcContent).toContain("NEXUS_WRAPPER_SELF_DIR");

    // Verify the PATH dedup pattern is present in both zshrc and bashrc.
    expect(zshrcContent).toContain("${PATH//:$NEXUS_WRAPPER_SELF_DIR:/:}");
    expect(bashrcContent).toContain("${PATH//:$NEXUS_WRAPPER_SELF_DIR:/:}");
  });

  test("acceptance 3 — idempotent: second call produces identical content", async () => {
    const id = "test-ws-idempotent-" + Date.now();
    const r1 = await writeShimFiles(id);
    createdShimDir = r1.dir;

    const before = {
      zshrc: await fsp.readFile(r1.zshrc, "utf-8"),
      zshenv: await fsp.readFile(r1.zshenv, "utf-8"),
      bashrc: await fsp.readFile(r1.bashrc, "utf-8"),
    };

    // Second call must not throw and must produce identical content.
    const r2 = await writeShimFiles(id);
    expect(r2.dir).toBe(r1.dir);

    const after = {
      zshrc: await fsp.readFile(r2.zshrc, "utf-8"),
      zshenv: await fsp.readFile(r2.zshenv, "utf-8"),
      bashrc: await fsp.readFile(r2.bashrc, "utf-8"),
    };

    expect(after.zshrc).toBe(before.zshrc);
    expect(after.zshenv).toBe(before.zshenv);
    expect(after.bashrc).toBe(before.bashrc);
  });

  test("acceptance 5 — dir mode 0700, file mode 0644", async () => {
    const id = "test-ws-mode-" + Date.now();
    const result = await writeShimFiles(id);
    createdShimDir = result.dir;

    const dirStat = fsSync.statSync(result.dir);
    expect(dirStat.mode & 0o777).toBe(0o700);

    for (const filePath of [result.zshrc, result.zshenv, result.bashrc]) {
      const fileStat = fsSync.statSync(filePath);
      expect(fileStat.mode & 0o777).toBe(0o644);
    }
  });

  test("acceptance 6 — generated files pass bash -n syntax check", async () => {
    const id = "test-ws-syntax-" + Date.now();
    const result = await writeShimFiles(id);
    createdShimDir = result.dir;

    for (const filePath of [result.zshrc, result.bashrc]) {
      expect(() => execSync(`bash -n "${filePath}"`, { stdio: "pipe" })).not.toThrow();
    }
  });
});

describe("removeShimDir", () => {
  let createdShimDir: string;

  afterEach(async () => {
    if (createdShimDir) {
      await fsp.rm(createdShimDir, { recursive: true, force: true });
      createdShimDir = "";
    }
  });

  test("acceptance 4 — removes the shim directory", async () => {
    const id = "test-ws-remove-" + Date.now();
    const result = await writeShimFiles(id);
    createdShimDir = result.dir;

    await removeShimDir(id);
    expect(fsSync.existsSync(result.dir)).toBe(false);

    // Second call (dir already gone) must not throw.
    await expect(removeShimDir(id)).resolves.toBeUndefined();
    createdShimDir = ""; // already cleaned up
  });

  test("does not throw when workspace shim dir never existed", async () => {
    const id = "test-ws-nonexistent-" + Date.now();
    await expect(removeShimDir(id)).resolves.toBeUndefined();
  });
});
