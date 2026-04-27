import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import { join, resolve } from "node:path";

import type { WorkspaceId } from "../../../../shared/src/contracts/workspace/workspace";
import { OpenSessionSidecarLifecycleManager } from "../../../src/main/sidecar/sidecar-lifecycle-manager";
import { SidecarBridge } from "../../../src/main/sidecar-bridge";
import { WorkspacePersistenceStore } from "../../../src/main/workspace/persistence/workspace-persistence";

const repoRoot = resolve(import.meta.dir, "../../../../..");
const sidecarDir = join(repoRoot, "sidecar");
const sidecarBin = join(sidecarDir, "bin", process.platform === "win32" ? "nexus-sidecar.exe" : "nexus-sidecar");

const liveManagers: OpenSessionSidecarLifecycleManager[] = [];
const tempDirs: string[] = [];

beforeAll(() => {
  mkdirSync(join(sidecarDir, "bin"), { recursive: true });
  const result = spawnSync("go", ["build", "-o", sidecarBin, "./cmd/nexus-sidecar"], {
    cwd: sidecarDir,
    encoding: "utf8",
  });
  expect(result.status, result.stderr || result.stdout).toBe(0);
});

afterEach(async () => {
  await Promise.allSettled(
    liveManagers.splice(0).flatMap((manager) => {
      const runtime = runtimeOf(manager);
      return runtime
        .listRunningWorkspaceIds()
        .map((workspaceId) => manager.stopSidecarForClosedWorkspace(workspaceId));
    }),
  );
  await Promise.all(tempDirs.splice(0).map((tempDir) => rm(tempDir, { recursive: true, force: true })));
});

describe("composition-equivalent sidecar lifecycle smoke", () => {
  test("SidecarBridge 주입 lifecycle manager가 workspace open에서 실제 sidecar를 spawn하고 token handshake를 완료한다", async () => {
    const { manager, runtime, workspaceId } = await createManagerWithOpenWorkspace({ sidecarBin });
    liveManagers.push(manager);

    await manager.startSidecarForOpenedWorkspace(workspaceId);

    const record = recordOf(runtime, workspaceId);
    expect(record.childProcess.pid).toBeGreaterThan(0);
    expect(drainStderr(record.childProcess)).toContain(
      `nexus-sidecar ready pid=${record.childProcess.pid} workspaceId=${workspaceId}`,
    );
    expect(record.startedEvent).toMatchObject({
      type: "sidecar/started",
      workspaceId,
      pid: record.childProcess.pid,
    });
    expect(runtime.listRunningWorkspaceIds()).toContain(workspaceId);

    const stopped = await runtime.stop({ type: "sidecar/stop", workspaceId, reason: "workspace-close" });
    expect(stopped).toMatchObject({ type: "sidecar/stopped", workspaceId, reason: "requested", exitCode: 0 });
  }, 10_000);

  test("missing sidecar binary는 spawn 없이 unavailable event(pid -1)를 반환한다", async () => {
    const { manager, runtime, workspaceId } = await createManagerWithOpenWorkspace({
      sidecarBin: join(os.tmpdir(), `missing-nexus-sidecar-${Date.now()}`),
    });

    await manager.startSidecarForOpenedWorkspace(workspaceId);

    expect(recordCountOf(runtime)).toBe(0);
    expect(runtime.listRunningWorkspaceIds()).toEqual([]);
  });
});

async function createManagerWithOpenWorkspace(options: { sidecarBin: string }): Promise<{
  manager: OpenSessionSidecarLifecycleManager;
  runtime: SidecarBridge;
  workspaceId: WorkspaceId;
}> {
  const storageDir = await mkdtemp(join(os.tmpdir(), "nexus-composition-smoke-store-"));
  const workspaceDir = await mkdtemp(join(os.tmpdir(), "nexus-composition-smoke-workspace-"));
  tempDirs.push(storageDir, workspaceDir);

  const store = new WorkspacePersistenceStore({ storageDir });
  const workspace = await store.registerWorkspace(workspaceDir, "composition-smoke");
  await store.openWorkspace(workspace.id);

  const runtime = new SidecarBridge({ sidecarBin: options.sidecarBin, readyTimeoutMs: 5_000, wsTimeoutMs: 2_000 });
  const manager = new OpenSessionSidecarLifecycleManager(store, runtime);
  expect(runtimeOf(manager)).toBe(runtime);

  return { manager, runtime, workspaceId: workspace.id };
}

function runtimeOf(manager: OpenSessionSidecarLifecycleManager): SidecarBridge {
  return (manager as unknown as { runtime: SidecarBridge }).runtime;
}

function recordOf(runtime: SidecarBridge, workspaceId: WorkspaceId): {
  childProcess: ChildProcess;
  startedEvent: unknown;
} {
  const records = (runtime as unknown as { recordsByWorkspaceId: Map<WorkspaceId, { childProcess: ChildProcess; startedEvent: unknown }> }).recordsByWorkspaceId;
  const record = records.get(workspaceId);
  expect(record).toBeDefined();
  return record!;
}

function drainStderr(childProcess: ChildProcess): string {
  let output = "";
  let chunk: Buffer | string | null;
  while ((chunk = childProcess.stderr?.read() ?? null) !== null) {
    output += chunk.toString();
  }
  return output;
}

function recordCountOf(runtime: SidecarBridge): number {
  return (runtime as unknown as { recordsByWorkspaceId: Map<WorkspaceId, unknown> }).recordsByWorkspaceId.size;
}
