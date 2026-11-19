import { afterEach, beforeEach, expect, test } from "bun:test";
import { bootstrapWorkbench, bootstrapWorkspaces } from "../../../../../src/renderer/bootstrap";
import { cycleActiveWorkspace } from "../../../../../src/renderer/commands/domains/workspace";
import { useActiveStore } from "../../../../../src/renderer/state/stores/active";
import { useAgentViewStore } from "../../../../../src/renderer/state/stores/agent-view";
import { useWorkspacesStore } from "../../../../../src/renderer/state/stores/workspaces";
import type { WorkspaceMeta } from "../../../../../src/shared/types/workspace";

const originalWindow = globalThis.window;
const globals = globalThis as { document?: unknown };
const originalDocument = globals.document;
let previousView = useAgentViewStore.getState().mode;
const local: WorkspaceMeta = {
  id: crypto.randomUUID(),
  name: "Local",
  location: { kind: "local", rootPath: "/repo" },
  rootPath: "/repo",
  color: "auto",
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
  previousView = useAgentViewStore.getState().mode;
  useAgentViewStore.setState({ mode: "workspace" });
  useWorkspacesStore.getState().setAll([]);
  useActiveStore.getState().setActiveWorkspaceId(null);
});

afterEach(() => {
  useWorkspacesStore.getState().setAll([]);
  useActiveStore.getState().setActiveWorkspaceId(null);
  Object.assign(globalThis, { window: originalWindow });
  globals.document = originalDocument;
  useAgentViewStore.setState({ mode: previousView });
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

test("startup restores the remembered workspace away from the first row without connecting it", async () => {
  const calls: string[] = [];
  setWorkspaceIpc(async (method) => {
    calls.push(method);
    if (method === "list") return [local, ssh];
    if (method === "connectionSnapshot") return [];
    return ssh.id;
  });

  await bootstrapWorkspaces();

  expect(useActiveStore.getState().activeWorkspaceId).toBe(ssh.id);
  expect(calls).toEqual(["list", "connectionSnapshot", "active"]);
});

test("a workspace selected while startup waits for the last active ID stays selected", async () => {
  const active = Promise.withResolvers<string>();
  const requested = Promise.withResolvers<void>();
  setWorkspaceIpc(async (method) => {
    if (method === "list") return [local, ssh];
    if (method === "active") {
      requested.resolve();
      return active.promise;
    }
  });
  const restoring = bootstrapWorkspaces();
  await requested.promise;
  cycleActiveWorkspace(-1);
  expect(useActiveStore.getState().activeWorkspaceId).toBe(ssh.id);
  active.resolve(local.id);
  await restoring;

  expect(useActiveStore.getState().activeWorkspaceId).toBe(ssh.id);
});

test("a CLI workspace request waits for app state, the workspace list, and the restored selection", async () => {
  globals.document = { activeElement: null, body: null };
  const appState = Promise.withResolvers<void>();
  const workspaceList = Promise.withResolvers<WorkspaceMeta[]>();
  const active = Promise.withResolvers<string>();
  const listRequested = Promise.withResolvers<void>();
  const activeRequested = Promise.withResolvers<void>();
  const responded = Promise.withResolvers<unknown>();
  const selections: unknown[] = [];
  let onRequest: ((args: unknown) => void) | undefined;
  Object.assign(globalThis, {
    window: {
      ipc: {
        call: async (channel: string, method: string, body: unknown) => {
          if (channel === "cli" && method === "uiRespond") responded.resolve(body);
          if (channel !== "workspace") return;
          if (method === "list") {
            listRequested.resolve();
            return workspaceList.promise;
          }
          if (method === "active") {
            activeRequested.resolve();
            return active.promise;
          }
          if (method === "activate") selections.push(body);
        },
        listen: (channel: string, event: string, callback: (args: unknown) => void) => {
          if (channel === "cli" && event === "uiRequest") onRequest = callback;
          return () => {};
        },
      },
    },
  });

  const starting = bootstrapWorkbench(() => appState.promise);
  onRequest?.({ requestId: "boot-show", op: "workspace.show", args: { workspaceId: ssh.id } });
  appState.resolve();
  await listRequested.promise;
  expect(selections).toEqual([]);
  workspaceList.resolve([local, ssh]);
  await activeRequested.promise;
  expect(selections).toEqual([]);
  active.resolve(local.id);

  await starting;
  expect(await responded.promise).toMatchObject({ requestId: "boot-show", ok: true });
  expect(selections).toEqual([{ id: ssh.id }]);
  expect(useActiveStore.getState().activeWorkspaceId).toBe(ssh.id);
});
