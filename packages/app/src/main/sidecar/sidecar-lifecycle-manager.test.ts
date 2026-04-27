import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type {
  SidecarStartCommand,
  SidecarStartedEvent,
  SidecarStopCommand,
  SidecarStoppedEvent,
} from "../../../../shared/src/contracts/sidecar/sidecar";
import type { WorkspaceId } from "../../../../shared/src/contracts/workspace/workspace";
import { OpenSessionSidecarLifecycleManager } from "./sidecar-lifecycle-manager";
import type { SidecarRuntime } from "./sidecar-runtime";
import { WorkspacePersistenceStore } from "../workspace/persistence/workspace-persistence";
import { WorkspaceShellService } from "../workspace/shell/workspace-shell-service";

function createSteppedClock(isoTimestamps: string[]): () => Date {
  let index = 0;
  return () => {
    const timestamp = isoTimestamps[Math.min(index, isoTimestamps.length - 1)];
    index += 1;
    return new Date(timestamp);
  };
}

describe("OpenSessionSidecarLifecycleManager", () => {
  test("opening starts sidecars, switching keeps them alive, and close stops only targeted sidecar", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "nexus-sidecar-open-close-"));
    const clock = createSteppedClock([
      "2026-04-24T07:00:00.000Z",
      "2026-04-24T07:00:05.000Z",
      "2026-04-24T07:00:10.000Z",
      "2026-04-24T07:00:15.000Z",
      "2026-04-24T07:00:20.000Z",
      "2026-04-24T07:00:25.000Z",
      "2026-04-24T07:00:30.000Z",
      "2026-04-24T07:00:35.000Z",
      "2026-04-24T07:00:40.000Z",
      "2026-04-24T07:00:45.000Z",
      "2026-04-24T07:00:50.000Z",
      "2026-04-24T07:00:55.000Z",
      "2026-04-24T07:01:00.000Z",
      "2026-04-24T07:01:05.000Z",
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
      const runtime = new FakeSidecarRuntime(clock);
      const lifecycleManager = new OpenSessionSidecarLifecycleManager(
        persistenceStore,
        runtime,
      );
      const shellService = new WorkspaceShellService(persistenceStore, lifecycleManager);

      await shellService.restoreWorkspaceSessionOnAppStart();
      expect(runtime.startCommands).toHaveLength(0);

      const sidebarAfterAlphaOpen = await shellService.openFolderIntoSession({
        absolutePath: alphaPath,
        displayName: "Alpha",
      });
      const sidebarAfterBetaOpen = await shellService.openFolderIntoSession({
        absolutePath: betaPath,
        displayName: "Beta",
      });
      const alphaWorkspaceId = sidebarAfterAlphaOpen.openWorkspaces[0]!.id;
      const betaWorkspaceId = sidebarAfterBetaOpen.openWorkspaces[1]!.id;

      expect(runtime.startCommands).toHaveLength(2);
      expect(runtime.startCommands.map((command) => command.reason)).toEqual([
        "workspace-open",
        "workspace-open",
      ]);
      expect(runtime.listRunningWorkspaceIds()).toEqual([alphaWorkspaceId, betaWorkspaceId]);

      await shellService.activateWorkspace(alphaWorkspaceId);
      await shellService.activateWorkspace(betaWorkspaceId);
      expect(runtime.stopCommands).toHaveLength(0);
      expect(runtime.listRunningWorkspaceIds()).toEqual([alphaWorkspaceId, betaWorkspaceId]);

      const sidebarAfterAlphaClose = await shellService.closeWorkspaceInSession(alphaWorkspaceId);
      expect(runtime.stopCommands).toHaveLength(1);
      expect(runtime.stopCommands[0]).toMatchObject({
        type: "sidecar/stop",
        workspaceId: alphaWorkspaceId,
        reason: "workspace-close",
      });
      expect(runtime.listRunningWorkspaceIds()).toEqual([betaWorkspaceId]);
      expect(sidebarAfterAlphaClose.openWorkspaces.map((workspace) => workspace.id)).toEqual([
        betaWorkspaceId,
      ]);
      expect(sidebarAfterAlphaClose.activeWorkspaceId).toBe(betaWorkspaceId);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test("relaunch restore starts prior open-session sidecars once without double spawning", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "nexus-sidecar-restore-"));
    const firstLaunchClock = createSteppedClock([
      "2026-04-24T08:00:00.000Z",
      "2026-04-24T08:00:05.000Z",
      "2026-04-24T08:00:10.000Z",
      "2026-04-24T08:00:15.000Z",
      "2026-04-24T08:00:20.000Z",
      "2026-04-24T08:00:25.000Z",
      "2026-04-24T08:00:30.000Z",
      "2026-04-24T08:00:35.000Z",
      "2026-04-24T08:00:40.000Z",
    ]);
    const secondLaunchClock = createSteppedClock([
      "2026-04-24T09:00:00.000Z",
      "2026-04-24T09:00:05.000Z",
      "2026-04-24T09:00:10.000Z",
      "2026-04-24T09:00:15.000Z",
      "2026-04-24T09:00:20.000Z",
      "2026-04-24T09:00:25.000Z",
      "2026-04-24T09:00:30.000Z",
      "2026-04-24T09:00:35.000Z",
      "2026-04-24T09:00:40.000Z",
    ]);

    try {
      const alphaPath = path.join(tempRoot, "alpha");
      const betaPath = path.join(tempRoot, "beta");
      await mkdir(alphaPath, { recursive: true });
      await mkdir(betaPath, { recursive: true });

      const firstLaunchStore = new WorkspacePersistenceStore({
        storageDir: tempRoot,
        now: firstLaunchClock,
      });
      const firstLaunchRuntime = new FakeSidecarRuntime(firstLaunchClock);
      const firstLaunchManager = new OpenSessionSidecarLifecycleManager(
        firstLaunchStore,
        firstLaunchRuntime,
      );
      const firstLaunchService = new WorkspaceShellService(
        firstLaunchStore,
        firstLaunchManager,
      );

      const alphaAndBetaState = await firstLaunchService.openFolderIntoSession({
        absolutePath: alphaPath,
        displayName: "Alpha",
      });
      await firstLaunchService.openFolderIntoSession({
        absolutePath: betaPath,
        displayName: "Beta",
      });
      expect(alphaAndBetaState.openWorkspaces).toHaveLength(1);

      const relaunchedStore = new WorkspacePersistenceStore({
        storageDir: tempRoot,
        now: secondLaunchClock,
      });
      const relaunchedRuntime = new FakeSidecarRuntime(secondLaunchClock);
      const relaunchedManager = new OpenSessionSidecarLifecycleManager(
        relaunchedStore,
        relaunchedRuntime,
      );
      const relaunchedService = new WorkspaceShellService(
        relaunchedStore,
        relaunchedManager,
      );

      const sidebarAfterFirstRestore = await relaunchedService.restoreWorkspaceSessionOnAppStart();
      const sidebarAfterSecondRestore =
        await relaunchedService.restoreWorkspaceSessionOnAppStart();

      expect(sidebarAfterFirstRestore.openWorkspaces.map((workspace) => workspace.displayName)).toEqual(
        ["Alpha", "Beta"],
      );
      expect(sidebarAfterSecondRestore.openWorkspaces.map((workspace) => workspace.displayName)).toEqual(
        ["Alpha", "Beta"],
      );

      expect(relaunchedRuntime.startCommands).toHaveLength(2);
      expect(relaunchedRuntime.startCommands.map((command) => command.reason)).toEqual([
        "session-restore",
        "session-restore",
      ]);
      expect(relaunchedRuntime.stopCommands).toHaveLength(0);
      expect(relaunchedRuntime.listRunningWorkspaceIds()).toEqual(
        sidebarAfterFirstRestore.openWorkspaces.map((workspace) => workspace.id),
      );
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});

class FakeSidecarRuntime implements SidecarRuntime {
  public readonly startCommands: SidecarStartCommand[] = [];
  public readonly stopCommands: SidecarStopCommand[] = [];
  private readonly runningProcesses = new Map<WorkspaceId, SidecarStartedEvent>();

  public constructor(private readonly now: () => Date) {}

  public async start(command: SidecarStartCommand): Promise<SidecarStartedEvent> {
    this.startCommands.push(command);

    const existingProcess = this.runningProcesses.get(command.workspaceId);
    if (existingProcess) {
      return existingProcess;
    }

    const startedEvent: SidecarStartedEvent = {
      type: "sidecar/started",
      workspaceId: command.workspaceId,
      pid: 2000 + this.runningProcesses.size + 1,
      startedAt: this.now().toISOString(),
    };
    this.runningProcesses.set(command.workspaceId, startedEvent);
    return startedEvent;
  }

  public async stop(command: SidecarStopCommand): Promise<SidecarStoppedEvent | null> {
    this.stopCommands.push(command);
    const existingProcess = this.runningProcesses.get(command.workspaceId);
    this.runningProcesses.delete(command.workspaceId);

    if (!existingProcess) {
      return null;
    }

    return {
      type: "sidecar/stopped",
      workspaceId: command.workspaceId,
      reason: "requested",
      stoppedAt: this.now().toISOString(),
      exitCode: 0,
    };
  }

  public listRunningWorkspaceIds(): WorkspaceId[] {
    return Array.from(this.runningProcesses.keys());
  }
}
