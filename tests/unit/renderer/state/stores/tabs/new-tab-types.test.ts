import { afterEach, beforeAll, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerAppStateChannel } from "../../../../../../src/main/features/app-state";
import { setupRouter } from "../../../../../../src/main/infra/ipc-router";
import { StateService } from "../../../../../../src/main/infra/storage/state-service";
import type { WorkspaceLayoutSnapshot } from "../../../../../../src/shared/types/layout";
import type { WorkspaceMeta } from "../../../../../../src/shared/types/workspace";

type Invoke = (
  event: { sender?: { id: number } },
  channel: string,
  method: string,
  args: unknown,
) => Promise<unknown>;

let invoke: Invoke;
mock.module("electron", () => ({
  ipcMain: {
    handle: (channel: string, handler: Invoke) => {
      if (channel === "ipc:call") invoke = handler;
    },
    on: () => {},
  },
}));

const originalWindow = globalThis.window;
let write: ReturnType<typeof Promise.withResolvers<unknown>>;
let schedule: (() => void) | undefined;

const { hydrateLayoutSnapshots, registerStatePersistence, unregisterStatePersistence } =
  await import("../../../../../../src/renderer/state/persistence");
const { useLayoutStore } = await import("../../../../../../src/renderer/state/stores/layout");
const { useTabsStore } = await import("../../../../../../src/renderer/state/stores/tabs");
const { ipcCallResult, mustSucceed } = await import("../../../../../../src/renderer/ipc/client");

const workspaceId = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
const workspace: WorkspaceMeta = {
  id: workspaceId,
  rootPath: "/repo",
  name: "Repo",
  location: { kind: "local", rootPath: "/repo" },
  colorTone: "default",
  pinned: false,
  sortOrder: 1,
  pinnedSortOrder: 0,
  tabs: [],
};

/** Pass renderer calls through the real router, using an in-process transport. */
function connectRenderer(): void {
  Object.assign(globalThis, {
    window: {
      ipc: {
        call: async (channel: string, method: string, args: unknown) => {
          const result = await invoke(
            { sender: { id: 1 } },
            channel,
            method,
            structuredClone(args),
          );
          if (channel === "appState" && method === "set") write.resolve(result);
          return structuredClone(result);
        },
      },
    },
  });
}

/** Clear the two stores to simulate a new render process. */
function resetStores(): void {
  useTabsStore.setState({ byWorkspace: {} });
  useLayoutStore.setState({ byWorkspace: {} });
}

/** Restore the app state's layouts through the bootstrap hydration path. */
async function restore(): Promise<void> {
  resetStores();
  const state = mustSucceed(await ipcCallResult("appState", "get", undefined));
  hydrateLayoutSnapshots(state.layoutByWorkspace);
}

/** Add a tab through the same stores used by the workbench. */
function addTab(args: Parameters<ReturnType<typeof useTabsStore.getState>["createTab"]>[1]) {
  const layout = useLayoutStore.getState();
  layout.ensureLayout(workspaceId);
  const tab = useTabsStore.getState().createTab(workspaceId, args);
  layout.attachTab(
    workspaceId,
    useLayoutStore.getState().byWorkspace[workspaceId].activeGroupId,
    tab.id,
  );
  return tab.id;
}

beforeAll(setupRouter);
afterEach(() => {
  unregisterStatePersistence();
  resetStores();
  Object.assign(globalThis, { window: originalWindow });
});

test("restores external and workspace files beside a browser while excluding Untitled", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nx-layout-roundtrip-"));
  const stateFile = join(dir, "app-state.json");
  write = Promise.withResolvers();
  connectRenderer();
  registerAppStateChannel(new StateService(stateFile), { listWorkspaces: () => [workspace] });

  const timer = globalThis.setTimeout;
  const cancel = globalThis.clearTimeout;
  try {
    // Control the real renderer persistence subscriber's debounce without sleeping.
    globalThis.setTimeout = ((callback: () => void) => {
      schedule = callback;
      return 1;
    }) as typeof setTimeout;
    globalThis.clearTimeout = (() => {
      schedule = undefined;
    }) as typeof clearTimeout;

    registerStatePersistence();
    const external = addTab({
      type: "editor",
      props: { workspaceId, filePath: "/outside/file.txt", origin: "external", readOnly: true },
    });
    const internal = addTab({
      type: "editor",
      props: { workspaceId, filePath: "/repo/file.txt" },
    });
    const browser = addTab({
      type: "browser",
      props: {
        initialUrl: "https://example.com",
        lastUrl: "https://example.com/end",
        partition: "p",
      },
    });
    const untitled = addTab({ type: "untitled", props: { untitledIndex: 1 } });
    schedule?.();
    await write.promise;
    unregisterStatePersistence();
    const reloaded = new StateService(stateFile);
    expect(reloaded.getState().layoutByWorkspace?.[workspaceId]?.tabs[0]).toMatchObject({
      props: { origin: "external" },
    });
    registerAppStateChannel(reloaded, { listWorkspaces: () => [workspace] });
    await restore();

    const tabs = useTabsStore.getState().byWorkspace[workspaceId];
    expect(tabs[external]).toMatchObject({ type: "editor", props: { origin: "external" } });
    expect(tabs[internal]).toMatchObject({ type: "editor", props: { filePath: "/repo/file.txt" } });
    expect(tabs[browser]).toMatchObject({
      type: "browser",
      props: { lastUrl: "https://example.com/end" },
    });
    expect(tabs[untitled]).toBeUndefined();
    expect(useLayoutStore.getState().byWorkspace[workspaceId].root).toMatchObject({
      tabIds: [external, internal, browser],
    });
  } finally {
    globalThis.setTimeout = timer;
    globalThis.clearTimeout = cancel;
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A snapshot written before the editor's origin could be stored. */
function legacySnapshot(id: string): WorkspaceLayoutSnapshot {
  const groupId = crypto.randomUUID();
  const tabs = ["/repo/in.txt", "/outside/out.txt", "relative.txt"].map((filePath) => ({
    id: crypto.randomUUID(),
    title: filePath,
    type: "editor" as const,
    props: { filePath, workspaceId: id },
  }));
  return {
    root: { kind: "leaf", id: groupId, tabIds: tabs.map((tab) => tab.id), activeTabId: tabs[2].id },
    activeGroupId: groupId,
    tabs,
  };
}

test("recovers only unambiguous legacy local external paths and repairs dropped tab references", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nx-layout-legacy-"));
  connectRenderer();
  const remote = {
    ...workspace,
    id: crypto.randomUUID(),
    location: { kind: "ssh" as const, host: "example.invalid", remotePath: "/repo" },
  };
  try {
    const state = new StateService(join(dir, "app-state.json"));
    const local = legacySnapshot(workspaceId);
    const ssh = legacySnapshot(remote.id);
    state.setState({ layoutByWorkspace: { [workspaceId]: local, [remote.id]: ssh } });
    registerAppStateChannel(state, { listWorkspaces: () => [workspace, remote] });
    await restore();

    const { byWorkspace } = useTabsStore.getState();
    expect(byWorkspace[workspaceId][local.tabs[0].id]).toMatchObject({
      props: { filePath: "/repo/in.txt" },
    });
    expect(byWorkspace[workspaceId][local.tabs[1].id]).toMatchObject({
      props: { origin: "external" },
    });
    expect(byWorkspace[workspaceId][local.tabs[2].id]).toBeUndefined();
    expect(Object.keys(byWorkspace[remote.id])).toEqual([ssh.tabs[0].id]);
    expect(useLayoutStore.getState().byWorkspace[workspaceId].root).toMatchObject({
      tabIds: [local.tabs[0].id, local.tabs[1].id],
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
