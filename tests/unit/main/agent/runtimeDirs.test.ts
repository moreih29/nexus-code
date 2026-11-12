/**
 * Unit tests for src/main/infra/agent/runtimeDirs.ts.
 *
 * Verifies that NEXUS_CODE_HOME moves root(), that ensureDir creates
 * directories with 0o700 permissions, and that the shim rc files keep the
 * wrappers first on PATH under real bash and zsh.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import fsSync from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  ensureDir,
  HOME_ENV,
  root,
  socketsDir,
  writeShimFiles,
} from "../../../../src/main/infra/agent/runtimeDirs";

/** Mode-bit tests: Windows file systems keep no POSIX mode bits. */
const modeTest = test.skipIf(process.platform === "win32");

describe("root", () => {
  const named = process.env[HOME_ENV];
  beforeEach(() => {
    delete process.env[HOME_ENV];
  });
  afterEach(() => {
    if (named === undefined) delete process.env[HOME_ENV];
    else process.env[HOME_ENV] = named;
  });

  test("is the directory NEXUS_CODE_HOME names, for a copy of the app beside the installed one", () => {
    const dir = path.join(os.tmpdir(), "nexus-code-qa");
    process.env[HOME_ENV] = dir;
    expect(root()).toBe(dir);
    expect(socketsDir()).toBe(path.join(dir, "sockets"));
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

  modeTest("creates directory with 0o700 permissions", async () => {
    const target = path.join(tmpBase, "secure");
    await ensureDir(target);

    const stat = fsSync.statSync(target);
    const perm = stat.mode & 0o777;
    expect(perm).toBe(0o700);
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

  test.skipIf(!fsSync.existsSync("/bin/zsh"))(
    "a login zsh under the shim still reads the user's .zprofile and .zlogin",
    async () => {
      const id = `test-ws-login-${Date.now()}`;
      const result = await writeShimFiles(id);
      createdShimDir = result.dir;
      await fsp.writeFile(path.join(tmpBase, ".zprofile"), "export FROM_ZPROFILE=yes\n");
      await fsp.writeFile(path.join(tmpBase, ".zlogin"), "export FROM_ZLOGIN=yes\n");

      const output = execSync(`/bin/zsh -l -i -c 'echo "$FROM_ZPROFILE $FROM_ZLOGIN"'`, {
        env: { HOME: tmpBase, ZDOTDIR: result.dir, NEXUS_USER_ZDOTDIR: "" },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });

      expect(output.trim()).toBe("yes yes");
    },
  );

  // A Codex tab's commands start from a login shell's environment, whose
  // profile resets the PATH: the shim puts the wrappers back first.
  const WRAPPERS = "/nexus-wrappers";
  const RESET = "export PATH=/usr/bin:/bin\n";

  test.skipIf(!fsSync.existsSync("/bin/bash"))(
    "bash puts the wrappers back first after a profile reset the PATH, through BASH_ENV",
    async () => {
      const id = `test-ws-bashenv-${Date.now()}`;
      const result = await writeShimFiles(id);
      createdShimDir = result.dir;
      await fsp.writeFile(path.join(tmpBase, ".profile"), RESET);
      const env = {
        HOME: tmpBase,
        PATH: `${WRAPPERS}:/usr/bin:/bin`,
        NEXUS_WRAPPER_SELF_DIR: WRAPPERS,
        BASH_ENV: path.join(result.dir, "bashenv"),
      };
      for (const flags of ["-lc", "-c"]) {
        const output = execSync(
          `/bin/bash ${flags} 'PATH=/usr/bin:$PATH; bash -c "echo \\$PATH"'`,
          {
            env,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
          },
        );
        expect(output.trim()).toBe(`${WRAPPERS}:/usr/bin:/usr/bin:/bin`);
      }
      const login = execSync(`/bin/bash -lc 'echo "$PATH"'`, {
        env,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      expect(login.trim().split(":")[0]).toBe(WRAPPERS);
    },
  );

  // A Windows Claude tab's Bash tool: NEXUS_WRAPPER_SELF_DIR is a Windows path
  // there, and NEXUS_BASH_WRAPPER_DIR the wrappers' copies as Git Bash names them.
  test.skipIf(!fsSync.existsSync("/bin/bash"))(
    "bash puts Git Bash's wrapper directory first in place of the launchers'",
    async () => {
      const id = `test-ws-gitbash-${Date.now()}`;
      const result = await writeShimFiles(id);
      createdShimDir = result.dir;
      const output = execSync(`/bin/bash -c 'echo "$PATH"'`, {
        env: {
          HOME: tmpBase,
          PATH: "/usr/bin:/bin",
          NEXUS_WRAPPER_SELF_DIR: "C:\\Users\\u\\.nexus-code\\cli",
          NEXUS_BASH_WRAPPER_DIR: WRAPPERS,
          BASH_ENV: path.join(result.dir, "bashenv"),
        },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      expect(output.trim()).toBe(`${WRAPPERS}:/usr/bin:/bin`);
    },
  );

  test.skipIf(!fsSync.existsSync("/bin/zsh"))(
    "zsh puts the wrappers back first after its startup files reset the PATH",
    async () => {
      const id = `test-ws-zlogin-${Date.now()}`;
      const result = await writeShimFiles(id);
      createdShimDir = result.dir;
      await fsp.writeFile(path.join(tmpBase, ".zshenv"), RESET);
      await fsp.writeFile(path.join(tmpBase, ".zprofile"), RESET);
      for (const flags of ["-lc", "-c"]) {
        const output = execSync(`/bin/zsh ${flags} 'echo "$PATH"'`, {
          env: {
            HOME: tmpBase,
            PATH: `${WRAPPERS}:/usr/bin:/bin`,
            NEXUS_WRAPPER_SELF_DIR: WRAPPERS,
            ZDOTDIR: result.dir,
            NEXUS_USER_ZDOTDIR: "",
          },
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        });
        expect(output.trim().split(":")[0]).toBe(WRAPPERS);
      }
    },
  );

  modeTest("acceptance 5 — dir mode 0700, file mode 0644", async () => {
    const id = `test-ws-mode-${Date.now()}`;
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
    const id = `test-ws-syntax-${Date.now()}`;
    const result = await writeShimFiles(id);
    createdShimDir = result.dir;

    for (const filePath of [result.zshrc, result.bashrc]) {
      expect(() => execSync(`bash -n "${filePath}"`, { stdio: "pipe" })).not.toThrow();
    }
  });
});
