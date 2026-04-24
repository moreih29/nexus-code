import { describe, expect, test } from "bun:test";

import {
  WORKSPACE_ACTIVATE_CHANNEL,
  WORKSPACE_CLOSE_CHANNEL,
  WORKSPACE_GET_SIDEBAR_STATE_CHANNEL,
  WORKSPACE_OPEN_FOLDER_CHANNEL,
  WORKSPACE_RESTORE_SESSION_CHANNEL,
} from "../../../../shared/src/contracts/ipc-channels";
import type { WorkspaceSidebarState } from "../../../../shared/src/contracts/workspace-shell";
import {
  ElectronWorkspaceIpcAdapter,
  type ElectronWorkspaceIpcAdapterOptions,
  type WorkspaceIpcShellService,
} from "./electron-workspace-ipc-adapter";

const EMPTY_STATE: WorkspaceSidebarState = {
  openWorkspaces: [],
  activeWorkspaceId: null,
};

describe("ElectronWorkspaceIpcAdapter", () => {
  test("open-folder invokes native directory picker and opens selected path", async () => {
    const ipcMain = new FakeIpcMain();
    const workspaceService = new FakeWorkspaceShellService();
    const dialog = new FakeDialog({
      canceled: false,
      filePaths: ["/tmp/nexus/alpha"],
    });
    const observedSidebarStates: WorkspaceSidebarState[] = [];

    const adapter = createAdapter({
      ipcMain,
      workspaceShellService: workspaceService,
      dialog,
      onSidebarStateChanged: (nextSidebarState) => {
        observedSidebarStates.push(nextSidebarState);
      },
    });
    adapter.start();

    const expectedSidebarState: WorkspaceSidebarState = {
      openWorkspaces: [
        {
          id: "ws_alpha",
          absolutePath: "/tmp/nexus/alpha",
          displayName: "alpha",
        },
      ],
      activeWorkspaceId: "ws_alpha",
    };

    await expect(ipcMain.invoke(WORKSPACE_OPEN_FOLDER_CHANNEL)).resolves.toEqual(
      expectedSidebarState,
    );
    expect(dialog.calls).toEqual([
      {
        properties: ["openDirectory"],
      },
    ]);
    expect(workspaceService.openFolderCalls).toEqual([
      {
        absolutePath: "/tmp/nexus/alpha",
      },
    ]);
    expect(observedSidebarStates).toEqual([expectedSidebarState]);
  });

  test("open-folder cancel returns current sidebar state and emits update without opening a workspace", async () => {
    const ipcMain = new FakeIpcMain();
    const workspaceService = new FakeWorkspaceShellService();
    workspaceService.sidebarState = {
      openWorkspaces: [
        {
          id: "ws_existing",
          absolutePath: "/tmp/nexus/existing",
          displayName: "existing",
        },
      ],
      activeWorkspaceId: "ws_existing",
    };
    const observedSidebarStates: WorkspaceSidebarState[] = [];

    const adapter = createAdapter({
      ipcMain,
      workspaceShellService: workspaceService,
      dialog: new FakeDialog({
        canceled: true,
        filePaths: [],
      }),
      onSidebarStateChanged: (nextSidebarState) => {
        observedSidebarStates.push(nextSidebarState);
      },
    });
    adapter.start();

    await expect(ipcMain.invoke(WORKSPACE_OPEN_FOLDER_CHANNEL)).resolves.toEqual(
      workspaceService.sidebarState,
    );
    expect(workspaceService.openFolderCalls).toHaveLength(0);
    expect(workspaceService.getSidebarStateCalls).toBe(1);
    expect(observedSidebarStates).toEqual([workspaceService.sidebarState]);
  });

  test("activate, close, restore-session, and get-sidebar-state route to WorkspaceShellService and emit notifications except get", async () => {
    const ipcMain = new FakeIpcMain();
    const workspaceService = new FakeWorkspaceShellService();
    const observedSidebarStates: WorkspaceSidebarState[] = [];
    const adapter = createAdapter({
      ipcMain,
      workspaceShellService: workspaceService,
      dialog: new FakeDialog({
        canceled: true,
        filePaths: [],
      }),
      onSidebarStateChanged: (nextSidebarState) => {
        observedSidebarStates.push(nextSidebarState);
      },
    });
    adapter.start();

    workspaceService.sidebarState = {
      openWorkspaces: [
        {
          id: "ws_alpha",
          absolutePath: "/tmp/nexus/alpha",
          displayName: "alpha",
        },
      ],
      activeWorkspaceId: "ws_alpha",
    };

    await expect(ipcMain.invoke(WORKSPACE_ACTIVATE_CHANNEL, "ws_alpha")).resolves.toEqual(
      workspaceService.sidebarState,
    );
    await expect(ipcMain.invoke(WORKSPACE_CLOSE_CHANNEL, "ws_alpha")).resolves.toEqual(EMPTY_STATE);
    await expect(ipcMain.invoke(WORKSPACE_RESTORE_SESSION_CHANNEL)).resolves.toEqual(
      workspaceService.sidebarState,
    );
    await expect(ipcMain.invoke(WORKSPACE_GET_SIDEBAR_STATE_CHANNEL)).resolves.toEqual(
      workspaceService.sidebarState,
    );

    expect(workspaceService.activateCalls).toEqual(["ws_alpha"]);
    expect(workspaceService.closeCalls).toEqual(["ws_alpha"]);
    expect(workspaceService.restoreCalls).toBe(1);
    expect(workspaceService.getSidebarStateCalls).toBe(1);
    expect(observedSidebarStates).toEqual([
      {
        openWorkspaces: [
          {
            id: "ws_alpha",
            absolutePath: "/tmp/nexus/alpha",
            displayName: "alpha",
          },
        ],
        activeWorkspaceId: "ws_alpha",
      },
      EMPTY_STATE,
      EMPTY_STATE,
    ]);
  });

  test("stop removes all workspace IPC handlers", async () => {
    const ipcMain = new FakeIpcMain();
    const adapter = createAdapter({
      ipcMain,
      workspaceShellService: new FakeWorkspaceShellService(),
      dialog: new FakeDialog({
        canceled: true,
        filePaths: [],
      }),
      onSidebarStateChanged: () => {},
    });
    adapter.start();
    adapter.stop();

    expect(ipcMain.removedChannels).toEqual([
      WORKSPACE_OPEN_FOLDER_CHANNEL,
      WORKSPACE_ACTIVATE_CHANNEL,
      WORKSPACE_CLOSE_CHANNEL,
      WORKSPACE_RESTORE_SESSION_CHANNEL,
      WORKSPACE_GET_SIDEBAR_STATE_CHANNEL,
    ]);
    await expect(ipcMain.invoke(WORKSPACE_GET_SIDEBAR_STATE_CHANNEL)).rejects.toThrow(
      "No invoke handler is registered.",
    );
  });
});

function createAdapter(
  options: {
    ipcMain: FakeIpcMain;
    workspaceShellService: FakeWorkspaceShellService;
    dialog: FakeDialog;
    onSidebarStateChanged?: (nextSidebarState: WorkspaceSidebarState) => void;
  },
): ElectronWorkspaceIpcAdapter {
  const adapterOptions: ElectronWorkspaceIpcAdapterOptions = {
    ipcMain: options.ipcMain as unknown as ElectronWorkspaceIpcAdapterOptions["ipcMain"],
    workspaceShellService:
      options.workspaceShellService as unknown as WorkspaceIpcShellService,
    dialog: options.dialog as unknown as ElectronWorkspaceIpcAdapterOptions["dialog"],
    onSidebarStateChanged: options.onSidebarStateChanged,
  };
  return new ElectronWorkspaceIpcAdapter(adapterOptions);
}

class FakeWorkspaceShellService {
  public sidebarState: WorkspaceSidebarState = EMPTY_STATE;

  public readonly openFolderCalls: Array<{ absolutePath: string }> = [];
  public readonly activateCalls: string[] = [];
  public readonly closeCalls: string[] = [];
  public restoreCalls = 0;
  public getSidebarStateCalls = 0;

  public async openFolderIntoSession(request: {
    absolutePath: string;
  }): Promise<WorkspaceSidebarState> {
    this.openFolderCalls.push(request);
    this.sidebarState = {
      openWorkspaces: [
        {
          id: "ws_alpha",
          absolutePath: request.absolutePath,
          displayName: "alpha",
        },
      ],
      activeWorkspaceId: "ws_alpha",
    };
    return this.sidebarState;
  }

  public async activateWorkspace(workspaceId: string): Promise<WorkspaceSidebarState> {
    this.activateCalls.push(workspaceId);
    return this.sidebarState;
  }

  public async closeWorkspaceInSession(workspaceId: string): Promise<WorkspaceSidebarState> {
    this.closeCalls.push(workspaceId);
    this.sidebarState = EMPTY_STATE;
    return this.sidebarState;
  }

  public async restoreWorkspaceSessionOnAppStart(): Promise<WorkspaceSidebarState> {
    this.restoreCalls += 1;
    return this.sidebarState;
  }

  public async getSidebarState(): Promise<WorkspaceSidebarState> {
    this.getSidebarStateCalls += 1;
    return this.sidebarState;
  }
}

class FakeDialog {
  public readonly calls: Array<{ properties: string[] }> = [];

  public constructor(
    private readonly result: {
      canceled: boolean;
      filePaths: string[];
    },
  ) {}

  public async showOpenDialog(options: {
    properties: string[];
  }): Promise<{ canceled: boolean; filePaths: string[] }> {
    this.calls.push(options);
    return this.result;
  }
}

class FakeIpcMain {
  public readonly removedChannels: string[] = [];

  private readonly invokeHandlers = new Map<
    string,
    (event: unknown, payload?: unknown) => Promise<unknown> | unknown
  >();

  public handle(
    channel: string,
    listener: (event: unknown, payload?: unknown) => Promise<unknown> | unknown,
  ): void {
    this.invokeHandlers.set(channel, listener);
  }

  public removeHandler(channel: string): void {
    this.removedChannels.push(channel);
    this.invokeHandlers.delete(channel);
  }

  public async invoke(channel: string, payload?: unknown): Promise<unknown> {
    const handler = this.invokeHandlers.get(channel);
    if (!handler) {
      throw new Error("No invoke handler is registered.");
    }
    return handler({}, payload);
  }
}
