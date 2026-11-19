import { afterEach, beforeEach, expect, test } from "bun:test";
import { cycleActiveWorkspace } from "../../../../../src/renderer/commands/domains/workspace";
import { useActiveStore } from "../../../../../src/renderer/state/stores/active";
import { useWorkspacesStore } from "../../../../../src/renderer/state/stores/workspaces";
import type { WorkspaceMeta } from "../../../../../src/shared/types/workspace";

const originalWindow = globalThis.window;
const local: WorkspaceMeta = {
  id: crypto.randomUUID(),
  name: "Local",
  location: { kind: "local", rootPath: "/repo" },
  rootPath: "/repo",
  colorTone: "default",
  pinned: false,
  tabs: [],
  sortOrder: 1,
  pinnedSortOrder: 0,
};
const ssh: WorkspaceMeta = {
  ...local,
  id: crypto.randomUUID(),
  name: "SSH",
  location: { kind: "ssh", host: "example.invalid", remotePath: "/remote" },
  rootPath: "/remote",
  sortOrder: 2,
};

/** Drives workspace IPC without constructing a window or opening a connection. */
function setWorkspaceIpc(call: (method: string, body: unknown) => Promise<unknown>): void {
  Object.assign(globalThis, {
    window: {
      ipc: {
        call: (channel: string, method: string, body: unknown) =>
          channel === "workspace" ? call(method, body) : Promise.resolve(undefined),
      },
    },
  });
}

beforeEach(() => {
  useWorkspacesStore.getState().setAll([]);
  useActiveStore.getState().setActiveWorkspaceId(null);
});

afterEach(() => {
  useWorkspacesStore.getState().setAll([]);
  useActiveStore.getState().setActiveWorkspaceId(null);
  Object.assign(globalThis, { window: originalWindow });
});

test("the workspace cycling shortcut selects and connects a disconnected SSH workspace", () => {
  let requested: unknown;
  setWorkspaceIpc(async (method, body) => {
    if (method === "activate") requested = body;
  });
  useWorkspacesStore.getState().setAll([local, ssh]);
  useActiveStore.getState().setActiveWorkspaceId(local.id);

  cycleActiveWorkspace(1);

  expect(useActiveStore.getState().activeWorkspaceId).toBe(ssh.id);
  expect(requested).toEqual({ id: ssh.id });
});
