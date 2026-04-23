import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { WorkspacePersistenceStore } from "../main/workspace-persistence";
import { WorkspaceShellService } from "../main/workspace-shell-service";
import type { WorkspaceSwitchCommand } from "../../../shared/src/contracts/workspace-switching";
import {
  type WorkspaceShellBridge,
  WorkspaceShellModel,
} from "./workspace-shell-model";
import { WorkspaceSwitchingCommands } from "./workspace-switching-commands";

function createSteppedClock(isoTimestamps: string[]): () => Date {
  let index = 0;
  return () => {
    const timestamp = isoTimestamps[Math.min(index, isoTimestamps.length - 1)];
    index += 1;
    return new Date(timestamp);
  };
}

describe("WorkspaceSwitchingCommands", () => {
  test("switches previous/next with wraparound using persisted sidebar order", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "nexus-switch-cycle-"));
    const clock = createSteppedClock([
      "2026-04-24T05:00:00.000Z",
      "2026-04-24T05:00:05.000Z",
      "2026-04-24T05:00:10.000Z",
      "2026-04-24T05:00:15.000Z",
      "2026-04-24T05:00:20.000Z",
      "2026-04-24T05:00:25.000Z",
      "2026-04-24T05:00:30.000Z",
      "2026-04-24T05:00:35.000Z",
      "2026-04-24T05:00:40.000Z",
      "2026-04-24T05:00:45.000Z",
      "2026-04-24T05:00:50.000Z",
      "2026-04-24T05:00:55.000Z",
      "2026-04-24T05:01:00.000Z",
      "2026-04-24T05:01:05.000Z",
      "2026-04-24T05:01:10.000Z",
      "2026-04-24T05:01:15.000Z",
    ]);

    try {
      const alphaPath = path.join(tempRoot, "alpha");
      const betaPath = path.join(tempRoot, "beta");
      const gammaPath = path.join(tempRoot, "gamma");
      await mkdir(alphaPath, { recursive: true });
      await mkdir(betaPath, { recursive: true });
      await mkdir(gammaPath, { recursive: true });

      const workspaceShellModel = await createInitializedWorkspaceShellModel(tempRoot, clock);
      await workspaceShellModel.openFolderIntoSession(alphaPath, "Alpha");
      await workspaceShellModel.openFolderIntoSession(betaPath, "Beta");
      await workspaceShellModel.openFolderIntoSession(gammaPath, "Gamma");

      const switchCommands = new WorkspaceSwitchingCommands(workspaceShellModel);
      const initialState = workspaceShellModel.getSidebarState();
      expect(initialState.openWorkspaces.map((workspace) => workspace.displayName)).toEqual([
        "Alpha",
        "Beta",
        "Gamma",
      ]);
      expect(initialState.activeWorkspaceId).toBe(initialState.openWorkspaces[2]!.id);

      await switchCommands.switchNext();
      const afterNextWrap = workspaceShellModel.getSidebarState();
      expect(afterNextWrap.activeWorkspaceId).toBe(afterNextWrap.openWorkspaces[0]!.id);

      await switchCommands.switchPrevious();
      const afterPreviousWrap = workspaceShellModel.getSidebarState();
      expect(afterPreviousWrap.activeWorkspaceId).toBe(
        afterPreviousWrap.openWorkspaces[2]!.id,
      );

      await switchCommands.execute({
        type: "workspace/switch-cycle",
        direction: "previous",
      });
      const afterSecondPrevious = workspaceShellModel.getSidebarState();
      expect(afterSecondPrevious.activeWorkspaceId).toBe(
        afterSecondPrevious.openWorkspaces[1]!.id,
      );
      expect(
        afterSecondPrevious.openWorkspaces.map((workspace) => workspace.displayName),
      ).toEqual(["Alpha", "Beta", "Gamma"]);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test("activates direct slots using sidebar ordering", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "nexus-switch-slot-"));
    const clock = createSteppedClock([
      "2026-04-24T06:00:00.000Z",
      "2026-04-24T06:00:05.000Z",
      "2026-04-24T06:00:10.000Z",
      "2026-04-24T06:00:15.000Z",
      "2026-04-24T06:00:20.000Z",
      "2026-04-24T06:00:25.000Z",
      "2026-04-24T06:00:30.000Z",
      "2026-04-24T06:00:35.000Z",
      "2026-04-24T06:00:40.000Z",
      "2026-04-24T06:00:45.000Z",
      "2026-04-24T06:00:50.000Z",
    ]);

    try {
      const alphaPath = path.join(tempRoot, "alpha");
      const betaPath = path.join(tempRoot, "beta");
      const gammaPath = path.join(tempRoot, "gamma");
      await mkdir(alphaPath, { recursive: true });
      await mkdir(betaPath, { recursive: true });
      await mkdir(gammaPath, { recursive: true });

      const workspaceShellModel = await createInitializedWorkspaceShellModel(tempRoot, clock);
      await workspaceShellModel.openFolderIntoSession(alphaPath, "Alpha");
      await workspaceShellModel.openFolderIntoSession(betaPath, "Beta");
      await workspaceShellModel.openFolderIntoSession(gammaPath, "Gamma");

      const switchCommands = new WorkspaceSwitchingCommands(workspaceShellModel);

      await switchCommands.activateDirectSlot(2);
      expect(workspaceShellModel.getSidebarState().activeWorkspaceId).toBe(
        workspaceShellModel.getSidebarState().openWorkspaces[1]!.id,
      );

      const command: WorkspaceSwitchCommand = {
        type: "workspace/switch-direct-slot",
        slotNumber: 1,
      };
      await switchCommands.execute(command);
      expect(workspaceShellModel.getSidebarState().activeWorkspaceId).toBe(
        workspaceShellModel.getSidebarState().openWorkspaces[0]!.id,
      );

      await switchCommands.activateDirectSlot(99);
      expect(workspaceShellModel.getSidebarState().activeWorkspaceId).toBe(
        workspaceShellModel.getSidebarState().openWorkspaces[0]!.id,
      );
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});

async function createInitializedWorkspaceShellModel(
  storageDir: string,
  now: () => Date,
): Promise<WorkspaceShellModel> {
  const persistenceStore = new WorkspacePersistenceStore({
    storageDir,
    now,
  });
  const workspaceShellService = new WorkspaceShellService(persistenceStore);
  const bridge: WorkspaceShellBridge = {
    restoreWorkspaceSession: () => workspaceShellService.getSidebarState(),
    openFolderIntoSession: (request) => workspaceShellService.openFolderIntoSession(request),
    activateWorkspace: (workspaceId) => workspaceShellService.activateWorkspace(workspaceId),
  };

  const model = new WorkspaceShellModel(bridge);
  await model.initialize();
  return model;
}
