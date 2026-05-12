import { beforeEach, describe, expect, test } from "bun:test";
import type { WorkspaceMeta } from "../../../../../src/shared/types/workspace";

type ListenerRecord = {
  channel: string;
  event: string;
  callback: (args: unknown) => void;
};

const listeners: ListenerRecord[] = [];
const { createWorkspacesStore } = await import(
  "../../../../../src/renderer/state/stores/workspaces"
);
const useWorkspacesStore = createWorkspacesStore({
  canUseIpcBridge: () => true,
  listen: (channel, event, callback) => {
    listeners.push({
      channel,
      event,
      callback: callback as (args: unknown) => void,
    });
    return () => {};
  },
});

const WORKSPACE_ID = "123e4567-e89b-42d3-a456-426614174000";

/**
 * Builds the minimum workspace metadata needed by the workspaces store tests.
 */
function makeWorkspace(id = WORKSPACE_ID): WorkspaceMeta {
  return {
    id,
    name: "local",
    location: { kind: "local", rootPath: "/tmp/project" },
    rootPath: "/tmp/project",
    colorTone: "default",
    pinned: false,
    lastOpenedAt: new Date().toISOString(),
    tabs: [],
  };
}

/**
 * Delivers captured workspaces-store IPC events to their callbacks.
 */
function emitWorkspaceEvent(event: string, args: unknown): void {
  const matching = listeners.filter(
    (record) => record.channel === "workspace" && record.event === event,
  );
  if (matching.length === 0) {
    throw new Error(`workspace listener not registered: ${event}`);
  }
  for (const listener of matching) {
    listener.callback(args);
  }
}

/**
 * Resets mutable Zustand state between tests while preserving store actions.
 */
function resetStore(): void {
  useWorkspacesStore.setState({
    workspaces: [],
    connectionStatusByWorkspaceId: {},
  });
}

describe("workspaces store — connection status", () => {
  beforeEach(resetStore);

  test("listens to workspace.connectionChanged and stores status by workspace id", () => {
    emitWorkspaceEvent("connectionChanged", {
      workspaceId: WORKSPACE_ID,
      status: "connected",
    });

    expect(useWorkspacesStore.getState().connectionStatusByWorkspaceId[WORKSPACE_ID]).toBe(
      "connected",
    );
  });

  test("normalizes disconnected lifecycle events to idle display status", () => {
    emitWorkspaceEvent("connectionChanged", {
      workspaceId: WORKSPACE_ID,
      status: "disconnected",
    });

    expect(useWorkspacesStore.getState().connectionStatusByWorkspaceId[WORKSPACE_ID]).toBe("idle");
  });

  test("remove clears workspace connection status", () => {
    const workspace = makeWorkspace();
    useWorkspacesStore.getState().setAll([workspace]);
    useWorkspacesStore.getState().setConnectionStatus(WORKSPACE_ID, "connected");

    useWorkspacesStore.getState().remove(WORKSPACE_ID);

    expect(useWorkspacesStore.getState().connectionStatusByWorkspaceId[WORKSPACE_ID]).toBe(
      undefined,
    );
  });
});
