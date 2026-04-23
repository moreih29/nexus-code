import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { WorkspacePersistenceStore } from "../main/workspace-persistence";
import { WorkspaceShellService } from "../main/workspace-shell-service";
import {
  type WorkspaceShellBridge,
  WorkspaceShellModel,
} from "./workspace-shell-model";

function createSteppedClock(isoTimestamps: string[]): () => Date {
  let index = 0;
  return () => {
    const timestamp = isoTimestamps[Math.min(index, isoTimestamps.length - 1)];
    index += 1;
    return new Date(timestamp);
  };
}

describe("WorkspaceShellModel", () => {
  test("sidebar state is always sourced from persisted open-session data", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "nexus-shell-model-"));
    const clock = createSteppedClock([
      "2026-04-24T04:00:00.000Z",
      "2026-04-24T04:00:05.000Z",
      "2026-04-24T04:00:10.000Z",
      "2026-04-24T04:00:15.000Z",
      "2026-04-24T04:00:20.000Z",
      "2026-04-24T04:00:25.000Z",
      "2026-04-24T04:00:30.000Z",
      "2026-04-24T04:00:35.000Z",
      "2026-04-24T04:00:40.000Z",
      "2026-04-24T04:00:45.000Z",
      "2026-04-24T04:00:50.000Z",
      "2026-04-24T04:00:55.000Z",
    ]);

    try {
      const alphaPath = path.join(tempRoot, "alpha");
      const betaPath = path.join(tempRoot, "beta");
      await mkdir(alphaPath, { recursive: true });
      await mkdir(betaPath, { recursive: true });

      const persistenceStore = new WorkspacePersistenceStore({
        storageDir: tempRoot,
        now: clock,
      });
      const workspaceShellService = new WorkspaceShellService(persistenceStore);
      const bridge: WorkspaceShellBridge = {
        restoreWorkspaceSession: () => workspaceShellService.getSidebarState(),
        openFolderIntoSession: (request) => workspaceShellService.openFolderIntoSession(request),
        activateWorkspace: (workspaceId) =>
          workspaceShellService.activateWorkspace(workspaceId),
      };

      const workspaceShellModel = new WorkspaceShellModel(bridge);
      const initialState = await workspaceShellModel.initialize();
      expect(initialState.openWorkspaces).toHaveLength(0);
      expect(initialState.activeWorkspaceId).toBeNull();

      await workspaceShellModel.openFolderIntoSession(alphaPath, "Alpha");
      await workspaceShellModel.openFolderIntoSession(betaPath, "Beta");

      const stateAfterOpenFlow = workspaceShellModel.getSidebarState();
      expect(stateAfterOpenFlow.openWorkspaces.map((workspace) => workspace.displayName)).toEqual(
        ["Alpha", "Beta"],
      );
      expect(stateAfterOpenFlow.activeWorkspaceId).toBe(
        stateAfterOpenFlow.openWorkspaces[1]!.id,
      );

      await workspaceShellModel.activateWorkspace(stateAfterOpenFlow.openWorkspaces[0]!.id);
      const stateAfterClickActivation = workspaceShellModel.getSidebarState();
      expect(stateAfterClickActivation.activeWorkspaceId).toBe(
        stateAfterClickActivation.openWorkspaces[0]!.id,
      );

      const sidebarHtml = workspaceShellModel.renderSidebarHtml();
      expect(sidebarHtml).toContain('data-action="open-folder"');
      expect(sidebarHtml).toContain("Alpha");
      expect(sidebarHtml).toContain("Beta");

      const alphaButtonIndex = sidebarHtml.indexOf("Alpha");
      const betaButtonIndex = sidebarHtml.indexOf("Beta");
      expect(alphaButtonIndex).toBeLessThan(betaButtonIndex);
      expect(sidebarHtml).toContain('aria-current="page"');
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});
