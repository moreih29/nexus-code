import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  LAST_SESSION_SNAPSHOT_FILENAME,
  WORKSPACE_REGISTRY_FILENAME,
  WorkspacePersistenceStore,
  createWorkspaceId,
  normalizeWorkspaceAbsolutePath,
} from "./workspace-persistence";

function createSteppedClock(isoTimestamps: string[]): () => Date {
  let index = 0;
  return () => {
    const timestamp = isoTimestamps[Math.min(index, isoTimestamps.length - 1)];
    index += 1;
    return new Date(timestamp);
  };
}

describe("WorkspacePersistenceStore", () => {
  test("registerWorkspace stores NFC-normalized absolute path with stable workspace id", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "nexus-registry-"));
    const clock = createSteppedClock([
      "2026-04-24T01:00:00.000Z",
      "2026-04-24T01:01:00.000Z",
    ]);

    try {
      const store = new WorkspacePersistenceStore({
        storageDir: tempRoot,
        now: clock,
      });

      const decomposedDirectoryName = "Cafe\u0301";
      const workspacePath = path.join(tempRoot, decomposedDirectoryName);
      await mkdir(workspacePath, { recursive: true });

      const firstEntry = await store.registerWorkspace(workspacePath);
      const secondEntry = await store.registerWorkspace(workspacePath, "Cafe Root");
      const registry = await store.getWorkspaceRegistry();

      const expectedAbsolutePath = normalizeWorkspaceAbsolutePath(workspacePath);
      expect(firstEntry.absolutePath).toBe(expectedAbsolutePath);
      expect(firstEntry.absolutePath).toBe(firstEntry.absolutePath.normalize("NFC"));
      expect(firstEntry.id).toBe(createWorkspaceId(expectedAbsolutePath));
      expect(secondEntry.id).toBe(firstEntry.id);
      expect(registry.workspaces).toHaveLength(1);
      expect(registry.workspaces[0]?.displayName).toBe("Cafe Root");

      const registryJson = JSON.parse(
        await readFile(path.join(tempRoot, WORKSPACE_REGISTRY_FILENAME), "utf8"),
      ) as { version: number };
      expect(registryJson.version).toBe(1);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test("persists open order + active workspace and restores after relaunch", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "nexus-session-"));
    const clock = createSteppedClock([
      "2026-04-24T02:00:00.000Z",
      "2026-04-24T02:00:05.000Z",
      "2026-04-24T02:00:10.000Z",
      "2026-04-24T02:00:15.000Z",
      "2026-04-24T02:00:20.000Z",
      "2026-04-24T02:00:25.000Z",
      "2026-04-24T02:00:30.000Z",
      "2026-04-24T02:00:35.000Z",
      "2026-04-24T02:00:40.000Z",
      "2026-04-24T02:00:45.000Z",
      "2026-04-24T02:00:50.000Z",
      "2026-04-24T02:00:55.000Z",
    ]);

    try {
      const workspacePaths = ["alpha", "beta", "gamma"].map((segment) => {
        return path.join(tempRoot, segment);
      });
      for (const workspacePath of workspacePaths) {
        await mkdir(workspacePath, { recursive: true });
      }

      const storeBeforeRelaunch = new WorkspacePersistenceStore({
        storageDir: tempRoot,
        now: clock,
      });

      const alpha = await storeBeforeRelaunch.registerWorkspace(workspacePaths[0], "Alpha");
      const beta = await storeBeforeRelaunch.registerWorkspace(workspacePaths[1], "Beta");
      const gamma = await storeBeforeRelaunch.registerWorkspace(workspacePaths[2], "Gamma");

      await storeBeforeRelaunch.openWorkspace(alpha.id);
      await storeBeforeRelaunch.openWorkspace(beta.id);
      await storeBeforeRelaunch.openWorkspace(gamma.id);
      await storeBeforeRelaunch.activateWorkspace(beta.id);

      const storeAfterRelaunch = new WorkspacePersistenceStore({
        storageDir: tempRoot,
        now: clock,
      });
      const restoredSession = await storeAfterRelaunch.restoreWorkspaceSession();

      expect(restoredSession.snapshot.openWorkspaceIds).toEqual([
        alpha.id,
        beta.id,
        gamma.id,
      ]);
      expect(restoredSession.snapshot.activeWorkspaceId).toBe(beta.id);
      expect(restoredSession.openWorkspaces.map((workspace) => workspace.id)).toEqual([
        alpha.id,
        beta.id,
        gamma.id,
      ]);
      expect(restoredSession.activeWorkspace?.id).toBe(beta.id);

      await storeAfterRelaunch.closeWorkspace(beta.id);
      await storeAfterRelaunch.openWorkspace(beta.id);

      const storeAfterSecondRelaunch = new WorkspacePersistenceStore({
        storageDir: tempRoot,
        now: clock,
      });
      const restoredAgain = await storeAfterSecondRelaunch.restoreWorkspaceSession();
      expect(restoredAgain.snapshot.openWorkspaceIds).toEqual([alpha.id, gamma.id, beta.id]);
      expect(restoredAgain.snapshot.activeWorkspaceId).toBe(beta.id);

      const snapshotJson = JSON.parse(
        await readFile(path.join(tempRoot, LAST_SESSION_SNAPSHOT_FILENAME), "utf8"),
      ) as { activeWorkspaceId: string | null; openWorkspaceIds: string[] };
      expect(snapshotJson.openWorkspaceIds).toEqual([alpha.id, gamma.id, beta.id]);
      expect(snapshotJson.activeWorkspaceId).toBe(beta.id);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});
