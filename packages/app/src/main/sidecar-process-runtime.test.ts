import { describe, expect, test } from "bun:test";
import path from "node:path";

import type { WorkspaceId } from "../../../shared/src/contracts/workspace";
import {
  SidecarProcessRuntime,
  resolveSidecarBinaryPath,
} from "./sidecar-process-runtime";

const SIDECAR_BINARY_NAME =
  process.platform === "win32" ? "nexus-sidecar.exe" : "nexus-sidecar";

describe("resolveSidecarBinaryPath", () => {
  test("prefers repo sidecar/bin binary during development", () => {
    const repoRoot = path.resolve("/repo");
    const expectedBinaryPath = path.join(repoRoot, "sidecar", "bin", SIDECAR_BINARY_NAME);

    const resolvedPath = resolveSidecarBinaryPath({
      appPath: path.join(repoRoot, "packages", "app", "out", "main"),
      cwd: path.join(repoRoot, "packages", "app"),
      resourcesPath: path.join(repoRoot, "resources"),
      isPackaged: false,
      existsSyncFn: (candidatePath) => candidatePath === expectedBinaryPath,
    });

    expect(resolvedPath).toBe(expectedBinaryPath);
  });

  test("uses process.resourcesPath sidecar binary when packaged", () => {
    const resourcesPath = path.resolve("/Applications/Nexus.app/Contents/Resources");
    const packagedBinaryPath = path.join(resourcesPath, "sidecar", SIDECAR_BINARY_NAME);

    const resolvedPath = resolveSidecarBinaryPath({
      appPath: "/tmp/irrelevant-app-path",
      cwd: "/tmp/irrelevant-cwd",
      resourcesPath,
      isPackaged: true,
      existsSyncFn: (candidatePath) => candidatePath === packagedBinaryPath,
    });

    expect(resolvedPath).toBe(packagedBinaryPath);
  });
});

describe("SidecarProcessRuntime", () => {
  test("does not throw when sidecar binary is missing", async () => {
    const warnings: string[] = [];
    const runtime = new SidecarProcessRuntime({
      appPath: "/repo/packages/app",
      cwd: "/repo/packages/app",
      resourcesPath: "/tmp/resources",
      isPackaged: false,
      existsSyncFn: () => false,
      logger: {
        info: () => undefined,
        warn: (message) => {
          warnings.push(message);
        },
      },
      now: () => new Date("2026-04-24T12:00:00.000Z"),
    });

    const workspaceId = "ws_missing_sidecar" as WorkspaceId;

    const startedEvent = await runtime.start({
      type: "sidecar/start",
      workspaceId,
      workspacePath: "/repo/workspaces/missing-sidecar",
      reason: "session-restore",
    });
    await runtime.start({
      type: "sidecar/start",
      workspaceId,
      workspacePath: "/repo/workspaces/missing-sidecar",
      reason: "workspace-open",
    });

    expect(startedEvent).toEqual({
      type: "sidecar/started",
      workspaceId,
      pid: -1,
      startedAt: "2026-04-24T12:00:00.000Z",
    });
    expect(runtime.listRunningWorkspaceIds()).toEqual([]);
    expect(
      await runtime.stop({
        type: "sidecar/stop",
        workspaceId,
        reason: "app-shutdown",
      }),
    ).toBeNull();

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("sidecar binary not found");
  });
});
