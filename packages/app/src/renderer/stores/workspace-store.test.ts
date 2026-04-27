import { describe, expect, test } from "bun:test";

import type { WorkspaceSidebarState } from "../../../../shared/src/contracts/workspace/workspace-shell";
import {
  createWorkspaceStore,
  type WorkspaceSidebarBridge,
} from "./workspace-store";

describe("workspace-store", () => {
  test("hydrates and updates state using workspace bridge responses", async () => {
    const initialState: WorkspaceSidebarState = {
      openWorkspaces: [],
      activeWorkspaceId: null,
    };
    const stateAfterLoad: WorkspaceSidebarState = {
      openWorkspaces: [
        {
          id: "ws_alpha",
          displayName: "Alpha",
          absolutePath: "/tmp/alpha",
        },
      ],
      activeWorkspaceId: "ws_alpha",
    };
    const stateAfterOpen: WorkspaceSidebarState = {
      openWorkspaces: [
        {
          id: "ws_alpha",
          displayName: "Alpha",
          absolutePath: "/tmp/alpha",
        },
        {
          id: "ws_beta",
          displayName: "Beta",
          absolutePath: "/tmp/beta",
        },
      ],
      activeWorkspaceId: "ws_beta",
    };
    const stateAfterActivate: WorkspaceSidebarState = {
      openWorkspaces: stateAfterOpen.openWorkspaces,
      activeWorkspaceId: "ws_alpha",
    };
    const stateAfterClose: WorkspaceSidebarState = {
      openWorkspaces: [stateAfterOpen.openWorkspaces[0]!],
      activeWorkspaceId: "ws_alpha",
    };

    const calls = {
      getSidebarState: 0,
      openFolder: [] as Array<{ absolutePath: string }>,
      activateWorkspace: [] as string[],
      closeWorkspace: [] as string[],
    };

    const bridge: WorkspaceSidebarBridge = {
      async getSidebarState() {
        calls.getSidebarState += 1;
        return stateAfterLoad;
      },
      async openFolder(request) {
        calls.openFolder.push(request);
        return stateAfterOpen;
      },
      async activateWorkspace(workspaceId) {
        calls.activateWorkspace.push(workspaceId);
        return stateAfterActivate;
      },
      async closeWorkspace(workspaceId) {
        calls.closeWorkspace.push(workspaceId);
        return stateAfterClose;
      },
    };

    const store = createWorkspaceStore(bridge);

    expect(store.getState().sidebarState).toEqual(initialState);

    await store.getState().refreshSidebarState();
    expect(store.getState().sidebarState).toEqual(stateAfterLoad);
    expect(calls.getSidebarState).toBe(1);

    await store.getState().openFolder();
    expect(store.getState().sidebarState).toEqual(stateAfterOpen);
    expect(calls.openFolder).toEqual([{ absolutePath: "" }]);

    await store.getState().activateWorkspace("ws_alpha");
    expect(store.getState().sidebarState).toEqual(stateAfterActivate);
    expect(calls.activateWorkspace).toEqual(["ws_alpha"]);

    await store.getState().closeWorkspace("ws_beta");
    expect(store.getState().sidebarState).toEqual(stateAfterClose);
    expect(calls.closeWorkspace).toEqual(["ws_beta"]);
  });

  test("applies sidebar-state-changed payloads directly", () => {
    const bridge: WorkspaceSidebarBridge = {
      async getSidebarState() {
        return {
          openWorkspaces: [],
          activeWorkspaceId: null,
        };
      },
      async openFolder(request) {
        return {
          openWorkspaces: [
            {
              id: "ws_alpha",
              absolutePath: request.absolutePath,
              displayName: "Alpha",
            },
          ],
          activeWorkspaceId: "ws_alpha",
        };
      },
      async activateWorkspace(workspaceId) {
        return {
          openWorkspaces: [
            {
              id: workspaceId,
              absolutePath: "/tmp/alpha",
              displayName: "Alpha",
            },
          ],
          activeWorkspaceId: workspaceId,
        };
      },
      async closeWorkspace() {
        return {
          openWorkspaces: [],
          activeWorkspaceId: null,
        };
      },
    };

    const store = createWorkspaceStore(bridge);

    const sidebarStateChangedPayload: WorkspaceSidebarState = {
      openWorkspaces: [
        {
          id: "ws_gamma",
          displayName: "Gamma",
          absolutePath: "/tmp/gamma",
        },
      ],
      activeWorkspaceId: "ws_gamma",
    };

    store.getState().applySidebarState(sidebarStateChangedPayload);

    expect(store.getState().sidebarState).toEqual(sidebarStateChangedPayload);
  });
});
