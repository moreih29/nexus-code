import { expect, test } from "bun:test";
import { bootstrapWorkspaces } from "../../../../../src/renderer/bootstrap";
import {
  selectIsWorkspaceOnline,
  useWorkspacesStore,
} from "../../../../../src/renderer/state/stores/workspaces";
import type { WorkspaceMeta } from "../../../../../src/shared/types/workspace";

test("a reopened window restores connected SSH workspaces and keeps status events received during startup", async () => {
  const stableId = crypto.randomUUID();
  const changedId = crypto.randomUUID();
  const workspaces: WorkspaceMeta[] = [stableId, changedId].map((id) => ({
    id,
    name: id,
    location: { kind: "ssh", host: "example.invalid", remotePath: "/repo" },
    rootPath: "/repo",
    color: "auto",
    pinned: false,
    sortOrder: 0,
    pinnedSortOrder: 0,
    tabs: [],
  }));
  const originalWindow = globalThis.window;
  const originalStore = useWorkspacesStore.getState();
  useWorkspacesStore.setState({ workspaces: [], connectionStatusByWorkspaceId: {} });
  Object.assign(globalThis, {
    window: {
      ipc: {
        call: async (_channel: string, method: string) => {
          if (method === "list") return workspaces;
          if (method === "active") return stableId;
          if (method === "connectionSnapshot") {
            useWorkspacesStore.getState().setConnectionStatus(changedId, "held-then-expired");
            return workspaces.map(({ id }) => ({ workspaceId: id, status: "connected" }));
          }
          throw new Error(`Unexpected request: ${method}`);
        },
      },
    },
  });
  try {
    await bootstrapWorkspaces();
    const state = useWorkspacesStore.getState();
    expect(selectIsWorkspaceOnline(state, stableId)).toBe(true);
    expect(selectIsWorkspaceOnline(state, changedId)).toBe(false);
    expect(state.connectionStatusByWorkspaceId[changedId]).toBe("held-then-expired");
  } finally {
    useWorkspacesStore.setState(originalStore);
    Object.assign(globalThis, { window: originalWindow });
  }
});
