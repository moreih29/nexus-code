import { describe, expect, test } from "bun:test";

import {
  WORKSPACE_ACTIVATE_CHANNEL,
  WORKSPACE_CLOSE_CHANNEL,
  WORKSPACE_GET_SIDEBAR_STATE_CHANNEL,
  WORKSPACE_OPEN_FOLDER_CHANNEL,
  WORKSPACE_RESTORE_SESSION_CHANNEL,
  WORKSPACE_SIDEBAR_STATE_CHANGED_CHANNEL,
} from "../../../shared/src/contracts/ipc-channels";
import type { WorkspaceSidebarState } from "../../../shared/src/contracts/workspace-shell";
import { createNexusWorkspaceApi } from "./nexus-workspace-api";

describe("createNexusWorkspaceApi", () => {
  test("invokes workspace IPC channels", async () => {
    const ipcRenderer = new FakeIpcRenderer();
    const api = createNexusWorkspaceApi(ipcRenderer);

    await api.openFolder({
      absolutePath: "/tmp/nexus/alpha",
      displayName: "Alpha",
    });
    await api.activateWorkspace("ws_alpha");
    await api.closeWorkspace("ws_alpha");
    await api.restoreSession();
    await api.getSidebarState();

    expect(ipcRenderer.invokeCalls).toEqual([
      {
        channel: WORKSPACE_OPEN_FOLDER_CHANNEL,
        payload: {
          absolutePath: "/tmp/nexus/alpha",
          displayName: "Alpha",
        },
      },
      {
        channel: WORKSPACE_ACTIVATE_CHANNEL,
        payload: "ws_alpha",
      },
      {
        channel: WORKSPACE_CLOSE_CHANNEL,
        payload: "ws_alpha",
      },
      {
        channel: WORKSPACE_RESTORE_SESSION_CHANNEL,
        payload: undefined,
      },
      {
        channel: WORKSPACE_GET_SIDEBAR_STATE_CHANNEL,
        payload: undefined,
      },
    ]);
  });

  test("subscribes and unsubscribes workspace:sidebar-state-changed listener", () => {
    const ipcRenderer = new FakeIpcRenderer();
    const api = createNexusWorkspaceApi(ipcRenderer);
    const observedStates: WorkspaceSidebarState[] = [];

    const subscription = api.onSidebarStateChanged((nextState) => {
      observedStates.push(nextState);
    });
    const payload: WorkspaceSidebarState = {
      openWorkspaces: [
        {
          id: "ws_alpha",
          absolutePath: "/tmp/nexus/alpha",
          displayName: "Alpha",
        },
      ],
      activeWorkspaceId: "ws_alpha",
    };
    ipcRenderer.emitSidebarStateChanged(payload);

    expect(observedStates).toEqual([payload]);

    subscription.dispose();
    ipcRenderer.emitSidebarStateChanged({
      openWorkspaces: [],
      activeWorkspaceId: null,
    });

    expect(observedStates).toEqual([payload]);
    expect(ipcRenderer.removedChannels).toEqual([WORKSPACE_SIDEBAR_STATE_CHANGED_CHANNEL]);
  });
});

class FakeIpcRenderer {
  public readonly invokeCalls: Array<{ channel: string; payload: unknown }> = [];
  public readonly removedChannels: string[] = [];

  private sidebarStateChangedListener:
    | ((event: unknown, payload: WorkspaceSidebarState) => void)
    | null = null;

  public invoke(channel: string, payload?: unknown): Promise<null> {
    this.invokeCalls.push({
      channel,
      payload,
    });
    return Promise.resolve(null);
  }

  public on(
    channel: string,
    listener: (event: unknown, payload: WorkspaceSidebarState) => void,
  ): void {
    if (channel === WORKSPACE_SIDEBAR_STATE_CHANGED_CHANNEL) {
      this.sidebarStateChangedListener = listener;
    }
  }

  public removeListener(
    channel: string,
    listener: (event: unknown, payload: WorkspaceSidebarState) => void,
  ): void {
    if (
      channel === WORKSPACE_SIDEBAR_STATE_CHANGED_CHANNEL &&
      this.sidebarStateChangedListener === listener
    ) {
      this.sidebarStateChangedListener = null;
    }

    this.removedChannels.push(channel);
  }

  public emitSidebarStateChanged(payload: WorkspaceSidebarState): void {
    this.sidebarStateChangedListener?.({}, payload);
  }
}
