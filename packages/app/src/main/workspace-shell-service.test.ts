import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { WorkspacePersistenceStore } from "./workspace-persistence";
import {
  type OpenSessionTerminalLifecycleManager,
  WorkspaceShellService,
} from "./workspace-shell-service";

function createSteppedClock(isoTimestamps: string[]): () => Date {
  let index = 0;
  return () => {
    const timestamp = isoTimestamps[Math.min(index, isoTimestamps.length - 1)];
    index += 1;
    return new Date(timestamp);
  };
}

describe("WorkspaceShellService", () => {
  test("open-folder flow persists open-session order and active workspace across relaunch", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "nexus-shell-service-"));
    const clock = createSteppedClock([
      "2026-04-24T03:00:00.000Z",
      "2026-04-24T03:00:05.000Z",
      "2026-04-24T03:00:10.000Z",
      "2026-04-24T03:00:15.000Z",
      "2026-04-24T03:00:20.000Z",
      "2026-04-24T03:00:25.000Z",
      "2026-04-24T03:00:30.000Z",
      "2026-04-24T03:00:35.000Z",
      "2026-04-24T03:00:40.000Z",
      "2026-04-24T03:00:45.000Z",
    ]);

    try {
      const alphaPath = path.join(tempRoot, "alpha");
      const betaPath = path.join(tempRoot, "beta");
      await mkdir(alphaPath, { recursive: true });
      await mkdir(betaPath, { recursive: true });

      const firstLaunchStore = new WorkspacePersistenceStore({
        storageDir: tempRoot,
        now: clock,
      });
      const firstLaunchService = new WorkspaceShellService(firstLaunchStore);

      await firstLaunchService.openFolderIntoSession({
        absolutePath: alphaPath,
        displayName: "Alpha",
      });
      await firstLaunchService.openFolderIntoSession({
        absolutePath: betaPath,
        displayName: "Beta",
      });
      const firstLaunchSidebar = await firstLaunchService.getSidebarState();
      expect(firstLaunchSidebar.openWorkspaces.map((workspace) => workspace.displayName)).toEqual([
        "Alpha",
        "Beta",
      ]);
      expect(firstLaunchSidebar.activeWorkspaceId).toBe(firstLaunchSidebar.openWorkspaces[1]?.id);

      await firstLaunchService.activateWorkspace(firstLaunchSidebar.openWorkspaces[0]!.id);

      const relaunchedStore = new WorkspacePersistenceStore({
        storageDir: tempRoot,
        now: clock,
      });
      const relaunchedService = new WorkspaceShellService(relaunchedStore);
      const relaunchedSidebar = await relaunchedService.getSidebarState();

      expect(relaunchedSidebar.openWorkspaces.map((workspace) => workspace.displayName)).toEqual([
        "Alpha",
        "Beta",
      ]);
      expect(relaunchedSidebar.activeWorkspaceId).toBe(
        relaunchedSidebar.openWorkspaces[0]!.id,
      );
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });


  test("open-folder flow invokes all settings registration coordinators", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "nexus-shell-service-claude-"));
    try {
      const alphaPath = path.join(tempRoot, "alpha");
      await mkdir(alphaPath, { recursive: true });
      const store = new WorkspacePersistenceStore({
        storageDir: tempRoot,
        now: () => new Date("2026-04-26T05:15:00.000Z"),
      });
      const claudeRegistration = new FakeClaudeSettingsRegistrationCoordinator();
      const codexRegistration = new FakeClaudeSettingsRegistrationCoordinator();
      const service = new WorkspaceShellService(
        store,
        undefined,
        undefined,
        [claudeRegistration, codexRegistration],
      );

      const opened = await service.openFolderIntoSession({
        absolutePath: alphaPath,
        displayName: "Alpha",
      });

      const expectedWorkspace = {
        id: opened.openWorkspaces[0]!.id,
        absolutePath: alphaPath,
        displayName: "Alpha",
      };
      expect(claudeRegistration.ensureRegisteredCalls).toEqual([expectedWorkspace]);
      expect(codexRegistration.ensureRegisteredCalls).toEqual([expectedWorkspace]);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test("closeWorkspaceInSession also requests terminal cleanup for the closed workspace", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "nexus-shell-service-close-"));
    const clock = createSteppedClock([
      "2026-04-24T10:00:00.000Z",
      "2026-04-24T10:00:05.000Z",
      "2026-04-24T10:00:10.000Z",
      "2026-04-24T10:00:15.000Z",
      "2026-04-24T10:00:20.000Z",
      "2026-04-24T10:00:25.000Z",
    ]);

    try {
      const alphaPath = path.join(tempRoot, "alpha");
      await mkdir(alphaPath, { recursive: true });

      const store = new WorkspacePersistenceStore({
        storageDir: tempRoot,
        now: clock,
      });
      const terminalLifecycleManager = new FakeTerminalLifecycleManager();
      const service = new WorkspaceShellService(
        store,
        undefined,
        terminalLifecycleManager,
      );

      const opened = await service.openFolderIntoSession({
        absolutePath: alphaPath,
        displayName: "Alpha",
      });
      const alphaWorkspaceId = opened.openWorkspaces[0]!.id;

      await service.closeWorkspaceInSession(alphaWorkspaceId);

      expect(terminalLifecycleManager.stopCalls).toEqual([alphaWorkspaceId]);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});

class FakeClaudeSettingsRegistrationCoordinator {
  public readonly ensureRegisteredCalls: Array<{
    id: string;
    absolutePath: string;
    displayName: string;
  }> = [];

  public async ensureRegistered(workspace: {
    id: string;
    absolutePath: string;
    displayName: string;
  }): Promise<unknown> {
    this.ensureRegisteredCalls.push({
      id: workspace.id,
      absolutePath: workspace.absolutePath,
      displayName: workspace.displayName,
    });
    return null;
  }

  public readonly unregisterCalls: Array<{
    id: string;
    absolutePath: string;
    displayName: string;
  }> = [];

  public async unregister(workspace: {
    id: string;
    absolutePath: string;
    displayName: string;
  }): Promise<unknown> {
    this.unregisterCalls.push({
      id: workspace.id,
      absolutePath: workspace.absolutePath,
      displayName: workspace.displayName,
    });
    return null;
  }
}

class FakeTerminalLifecycleManager implements OpenSessionTerminalLifecycleManager {
  public readonly stopCalls: string[] = [];

  public async stopTerminalsForClosedWorkspace(workspaceId: string): Promise<void> {
    this.stopCalls.push(workspaceId);
  }
}
