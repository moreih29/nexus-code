import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import type { WorkspaceId } from "../../../shared/src/contracts/workspace";
import {
  NEXUS_OPENCODE_HOST_ENV,
  NEXUS_OPENCODE_ORIGINAL_PATH_ENV,
  NEXUS_OPENCODE_ORIGINAL_ZDOTDIR_ENV,
  NEXUS_OPENCODE_PORT_ENV,
  NEXUS_OPENCODE_SHIM_DIR_ENV,
  NEXUS_OPENCODE_ZDOTDIR_ENV,
  OPENCODE_CONFIG_CONTENT_ENV,
  OPENCODE_HOST,
  OPENCODE_PORT_BASE,
  OPENCODE_PORT_SPAN,
  buildOpenCodeConfigContent,
  buildOpenCodeShimScript,
  buildOpenCodeTerminalEnvOverrides,
  buildOpenCodeZshStartupScript,
  ensureOpenCodeWorkspaceShim,
  ensureOpenCodeWorkspaceShims,
  openCodeShimDir,
  openCodeZshDotDir,
  resolveOpenCodePort,
} from "./opencode-runtime";

describe("opencode runtime helpers", () => {
  test("resolves deterministic localhost server config per workspace", () => {
    const workspaceId = "ws_alpha" as WorkspaceId;
    const port = resolveOpenCodePort(workspaceId);

    expect(port).toBeGreaterThanOrEqual(OPENCODE_PORT_BASE);
    expect(port).toBeLessThan(OPENCODE_PORT_BASE + OPENCODE_PORT_SPAN);
    expect(resolveOpenCodePort(workspaceId)).toBe(port);
    expect(JSON.parse(buildOpenCodeConfigContent(workspaceId))).toEqual({
      server: {
        hostname: OPENCODE_HOST,
        port,
      },
    });
    expect(buildOpenCodeTerminalEnvOverrides(workspaceId)).toEqual({
      [OPENCODE_CONFIG_CONTENT_ENV]: buildOpenCodeConfigContent(workspaceId),
      [NEXUS_OPENCODE_HOST_ENV]: OPENCODE_HOST,
      [NEXUS_OPENCODE_PORT_ENV]: String(port),
    });
  });

  test("builds terminal env overrides that prepend a workspace opencode shim", () => {
    const workspaceId = "ws_alpha" as WorkspaceId;
    const shimDir = "/tmp/nexus/opencode-shims/ws_alpha/bin";
    const zshDotDir = "/tmp/nexus/opencode-shims/ws_alpha/zsh";
    const basePath = "/usr/local/bin:/usr/bin:/bin";
    const baseZdotDir = "/Users/example";

    expect(
      buildOpenCodeTerminalEnvOverrides(workspaceId, {
        shimDir,
        zshDotDir,
        basePath,
        baseZdotDir,
      }),
    ).toMatchObject({
      [NEXUS_OPENCODE_SHIM_DIR_ENV]: shimDir,
      [NEXUS_OPENCODE_ORIGINAL_PATH_ENV]: basePath,
      [NEXUS_OPENCODE_ZDOTDIR_ENV]: zshDotDir,
      [NEXUS_OPENCODE_ORIGINAL_ZDOTDIR_ENV]: baseZdotDir,
      PATH: `${shimDir}:${basePath}`,
      ZDOTDIR: zshDotDir,
      [NEXUS_OPENCODE_HOST_ENV]: OPENCODE_HOST,
      [NEXUS_OPENCODE_PORT_ENV]: String(resolveOpenCodePort(workspaceId)),
      [OPENCODE_CONFIG_CONTENT_ENV]: buildOpenCodeConfigContent(workspaceId),
    });
  });

  test("creates executable and zsh startup shims that keep opencode first", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "nexus-opencode-shim-"));
    try {
      const workspaceId = "ws_alpha" as WorkspaceId;
      const shims = await ensureOpenCodeWorkspaceShims({ dataDir: root, workspaceId });
      const shimPath = path.join(shims.executableShimDir, "opencode");
      const content = await readFile(shimPath, "utf8");
      const mode = (await stat(shimPath)).mode & 0o777;
      const zshrcPath = path.join(shims.zshDotDir, ".zshrc");
      const zshrc = await readFile(zshrcPath, "utf8");

      expect(shims.executableShimDir).toBe(openCodeShimDir(root, workspaceId));
      expect(shims.zshDotDir).toBe(openCodeZshDotDir(root, workspaceId));
      expect(mode & 0o111).not.toBe(0);
      expect(content).toBe(buildOpenCodeShimScript());
      expect(content).toContain('exec "$candidate" --hostname "$host" --port "$port" "$@"');
      expect(content).toContain(NEXUS_OPENCODE_ORIGINAL_PATH_ENV);
      expect(zshrc).toBe(buildOpenCodeZshStartupScript(".zshrc"));
      expect(zshrc).toContain('path=("$_nexus_shim_dir"');
      expect(zshrc).toContain(NEXUS_OPENCODE_ORIGINAL_ZDOTDIR_ENV);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("keeps the workspace opencode shim first after zsh startup files rebuild PATH", async () => {
    const zshPath = "/bin/zsh";
    if (!existsSync(zshPath)) {
      return;
    }

    const root = await mkdtemp(path.join(os.tmpdir(), "nexus-opencode-zsh-"));
    try {
      const workspaceId = "ws_alpha" as WorkspaceId;
      const shims = await ensureOpenCodeWorkspaceShims({ dataDir: root, workspaceId });
      const userZdotDir = path.join(root, "user-zdot");
      const userBinDir = path.join(root, "user-bin");
      await Promise.all([
        mkdir(userZdotDir, { recursive: true }),
        mkdir(userBinDir, { recursive: true }),
      ]);
      await writeFile(path.join(userBinDir, "opencode"), "#!/bin/sh\necho real-opencode\n");
      await writeFile(
        path.join(userZdotDir, ".zshrc"),
        `export PATH=${userBinDir}:/usr/bin:/bin:$PATH\n`,
      );

      const env = buildOpenCodeTerminalEnvOverrides(workspaceId, {
        shimDir: shims.executableShimDir,
        zshDotDir: shims.zshDotDir,
        basePath: `${userBinDir}:/usr/bin:/bin`,
        baseZdotDir: userZdotDir,
      });
      const result = spawnSync(
        zshPath,
        ["-l", "-i", "-c", 'printf "%s\\n" "$PATH"; which opencode'],
        {
          cwd: root,
          env: {
            HOME: userZdotDir,
            TERM: "xterm-256color",
            ...env,
          },
          encoding: "utf8",
        },
      );

      expect(result.status).toBe(0);
      const stdoutLines = result.stdout.trim().split(/\r?\n/u);
      expect(stdoutLines[0]?.split(":")[0]).toBe(shims.executableShimDir);
      expect(stdoutLines.at(-1)).toBe(path.join(shims.executableShimDir, "opencode"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("keeps legacy executable shim helper", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "nexus-opencode-shim-"));
    try {
      const workspaceId = "ws_alpha" as WorkspaceId;
      const shimDir = await ensureOpenCodeWorkspaceShim({ dataDir: root, workspaceId });

      expect(shimDir).toBe(openCodeShimDir(root, workspaceId));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
