import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { WorkspaceId } from "../../../shared/src/contracts/workspace";
import {
  NEXUS_OPENCODE_HOST_ENV,
  NEXUS_OPENCODE_ORIGINAL_PATH_ENV,
  NEXUS_OPENCODE_PORT_ENV,
  NEXUS_OPENCODE_SHIM_DIR_ENV,
  OPENCODE_CONFIG_CONTENT_ENV,
  OPENCODE_HOST,
  OPENCODE_PORT_BASE,
  OPENCODE_PORT_SPAN,
  buildOpenCodeConfigContent,
  buildOpenCodeShimScript,
  buildOpenCodeTerminalEnvOverrides,
  ensureOpenCodeWorkspaceShim,
  openCodeShimDir,
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
    const shimDir = "/tmp/nexus/opencode-shims/ws_alpha";
    const basePath = "/usr/local/bin:/usr/bin:/bin";

    expect(buildOpenCodeTerminalEnvOverrides(workspaceId, { shimDir, basePath })).toMatchObject({
      [NEXUS_OPENCODE_SHIM_DIR_ENV]: shimDir,
      [NEXUS_OPENCODE_ORIGINAL_PATH_ENV]: basePath,
      PATH: `${shimDir}:${basePath}`,
      [NEXUS_OPENCODE_HOST_ENV]: OPENCODE_HOST,
      [NEXUS_OPENCODE_PORT_ENV]: String(resolveOpenCodePort(workspaceId)),
      [OPENCODE_CONFIG_CONTENT_ENV]: buildOpenCodeConfigContent(workspaceId),
    });
  });

  test("creates an executable opencode shim that adds hostname and port flags", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "nexus-opencode-shim-"));
    try {
      const workspaceId = "ws_alpha" as WorkspaceId;
      const shimDir = await ensureOpenCodeWorkspaceShim({ dataDir: root, workspaceId });
      const shimPath = path.join(shimDir, "opencode");
      const content = await readFile(shimPath, "utf8");
      const mode = (await stat(shimPath)).mode & 0o777;

      expect(shimDir).toBe(openCodeShimDir(root, workspaceId));
      expect(mode & 0o111).not.toBe(0);
      expect(content).toBe(buildOpenCodeShimScript());
      expect(content).toContain('exec "$candidate" --hostname "$host" --port "$port" "$@"');
      expect(content).toContain(NEXUS_OPENCODE_ORIGINAL_PATH_ENV);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
