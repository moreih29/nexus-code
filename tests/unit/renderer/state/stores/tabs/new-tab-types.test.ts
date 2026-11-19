import { afterEach, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerAppStateChannel } from "../../../../../../src/main/features/app-state";
import { ClosePersistence } from "../../../../../../src/main/features/window/close-persistence";
import { setupRouter } from "../../../../../../src/main/infra/ipc-router";
import { StateService } from "../../../../../../src/main/infra/storage/state-service";
import { type AppState, AppStateSchema } from "../../../../../../src/shared/types/app-state";
import type { WorkspaceLayoutSnapshot } from "../../../../../../src/shared/types/layout";
import type { WorkspaceMeta } from "../../../../../../src/shared/types/workspace";
import type { TimerScheduler } from "../../../../../../src/shared/util/timer-scheduler";

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
let listeners = new Map<string, (args: unknown) => void>();
const { registerWindowChannel } = await import("../../../../../../src/main/features/window/ipc");
const { initBrowserRuntimeSubscriptions, beginBrowserView, endBrowserView } = await import(
  "../../../../../../src/renderer/state/operations/browser"
);
const { closeTab } = await import("../../../../../../src/renderer/state/operations/tabs");

const {
  flushStatePersistence,
  hydrateLayoutSnapshots,
  installLayoutClosePersistence,
  registerStatePersistence,
  unregisterStatePersistence,
} = await import("../../../../../../src/renderer/state/persistence");
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
function connectRenderer({ beforeSave }: { beforeSave?: () => Promise<void> } = {}): void {
  listeners = new Map();
  Object.assign(globalThis, {
    window: {
      ipc: {
        call: async (channel: string, method: string, args: unknown) => {
          const isSave = channel === "appState" && method === "set";
          if (isSave) await beforeSave?.();
          const result = await invoke(
            { sender: { id: 1 } },
            channel,
            method,
            structuredClone(args),
          );
          return structuredClone(result);
        },
        listen: (channel: string, event: string, listener: (args: unknown) => void) => {
          const subscribed = listeners;
          const key = `${channel}.${event}`;
          subscribed.set(key, listener);
          return () => subscribed.delete(key);
        },
      },
    },
  });
}

/** Keep the IPC validation and JSON round trip while controlling storage in memory. */
function memoryState(initial: Partial<AppState> = {}): Pick<StateService, "getState" | "setState"> {
  let json = JSON.stringify(AppStateSchema.parse(initial));
  return {
    getState: () => AppStateSchema.parse(JSON.parse(json)),
    setState(patch) {
      json = JSON.stringify(AppStateSchema.parse({ ...JSON.parse(json), ...patch }));
    },
  };
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

/** Advances persistence time under test control. */
function fakeTimer(): TimerScheduler & { run(): void } {
  let scheduled: (() => void) | undefined;
  return {
    setTimeout(callback) {
      scheduled = callback;
      return callback;
    },
    clearTimeout(handle) {
      if (scheduled === handle) scheduled = undefined;
    },
    run() {
      scheduled?.();
    },
  };
}

beforeAll(setupRouter);
beforeEach(resetStores);
afterEach(() => {
  unregisterStatePersistence();
  resetStores();
  Object.assign(globalThis, { window: originalWindow });
});

test("restores external and workspace files beside a browser while excluding Untitled", async () => {
  const state = memoryState();
  connectRenderer();
  registerAppStateChannel(state, { listWorkspaces: () => [workspace] });
  registerStatePersistence(fakeTimer());
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
  expect(await flushStatePersistence()).toBe(true);
  unregisterStatePersistence();
  const savedTabs = state.getState().layoutByWorkspace?.[workspaceId]?.tabs;
  expect(savedTabs?.find((tab) => tab.id === external)).toMatchObject({
    props: { origin: "external" },
  });
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
  connectRenderer();
  const remote = {
    ...workspace,
    id: crypto.randomUUID(),
    location: { kind: "ssh" as const, host: "example.invalid", remotePath: "/repo" },
  };
  const local = legacySnapshot(workspaceId);
  const ssh = legacySnapshot(remote.id);
  const state = memoryState({ layoutByWorkspace: { [workspaceId]: local, [remote.id]: ssh } });
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
});

test("does not hydrate tabs or layout for a workspace deleted since the last save", async () => {
  connectRenderer();
  const removed = crypto.randomUUID();
  const state = memoryState({
    layoutByWorkspace: {
      [workspaceId]: legacySnapshot(workspaceId),
      [removed]: legacySnapshot(removed),
    },
  });
  registerAppStateChannel(state, { listWorkspaces: () => [workspace] });
  await restore();

  expect(useTabsStore.getState().byWorkspace[removed]).toBeUndefined();
  expect(useLayoutStore.getState().byWorkspace[removed]).toBeUndefined();
  expect(useLayoutStore.getState().byWorkspace[workspaceId]).toBeDefined();
});

test("closing flushes queued tab, split and browser URL changes after an older save without replacing another window's layout", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nx-layout-close-"));
  const stateFile = join(dir, "app-state.json");
  const inFlight = Promise.withResolvers<void>();
  const finishWrite = Promise.withResolvers<void>();
  const closed = Promise.withResolvers<void>();
  const warnings: string[] = [];
  const timer = fakeTimer();
  const otherWorkspace = { ...workspace, id: crypto.randomUUID() };
  const otherSnapshot = legacySnapshot(otherWorkspace.id);
  let saves = 0;
  connectRenderer({
    beforeSave() {
      if (++saves !== 1) return Promise.resolve();
      inFlight.resolve();
      return finishWrite.promise;
    },
  });
  const state = new StateService(stateFile);
  state.setState({ layoutByWorkspace: { [otherWorkspace.id]: otherSnapshot } });
  registerAppStateChannel(state, { listWorkspaces: () => [workspace, otherWorkspace] });
  const close = new ClosePersistence((warning) => warnings.push(warning), fakeTimer());
  registerWindowChannel(close);
  const stopListening = installLayoutClosePersistence();
  initBrowserRuntimeSubscriptions();

  try {
    await restore();
    registerStatePersistence(timer);
    const editor = addTab({ type: "editor", props: { workspaceId, filePath: "/repo/closed.txt" } });
    const browser = addTab({
      type: "browser",
      props: { initialUrl: "https://example.com", lastUrl: "https://example.com", partition: "p" },
    });
    timer.run();
    await inFlight.promise;

    closeTab(workspaceId, editor);
    const layout = useLayoutStore.getState().byWorkspace[workspaceId];
    const secondGroup = useLayoutStore
      .getState()
      .splitGroup(workspaceId, layout.activeGroupId, "horizontal", "after");
    useLayoutStore.getState().attachTab(
      workspaceId,
      secondGroup,
      useTabsStore.getState().createTab(workspaceId, {
        type: "editor",
        props: { workspaceId, filePath: "/repo/other.txt" },
      }).id,
    );
    const url = "https://example.com/latest";
    const viewId = beginBrowserView(workspaceId, browser);
    listeners.get("browser.navigated")?.({
      tabId: browser,
      viewId,
      url,
      canGoBack: true,
      canGoForward: false,
    });

    const otherWindowSave = {
      ...otherSnapshot,
      tabs: otherSnapshot.tabs.slice(0, 1).map((tab) => ({ ...tab, title: "new title" })),
    };
    await invoke({ sender: { id: 2 } }, "appState", "set", {
      layoutByWorkspace: { [otherWorkspace.id]: otherWindowSave },
    });

    const win = {
      webContents: {
        id: 1,
        send(_wire: string, channel: string, event: string, args: unknown) {
          listeners.get(`${channel}.${event}`)?.(args);
        },
      },
      isDestroyed: () => false,
      close: mock(() => closed.resolve()),
    };
    close.interceptClose({ preventDefault() {} }, win);
    expect(win.close).not.toHaveBeenCalled();
    finishWrite.resolve();
    await closed.promise;
    expect(saves).toBe(2);
    expect(warnings).toEqual([]);
    endBrowserView(browser, viewId);

    unregisterStatePersistence();
    registerAppStateChannel(new StateService(stateFile), {
      listWorkspaces: () => [workspace, otherWorkspace],
    });
    await restore();
    const tabs = useTabsStore.getState().byWorkspace;
    expect(tabs[workspaceId][editor]).toBeUndefined();
    expect(tabs[workspaceId][browser]).toMatchObject({ props: { lastUrl: url } });
    expect(useLayoutStore.getState().byWorkspace[workspaceId].root.kind).toBe("split");
    expect(tabs[otherWorkspace.id][otherWindowSave.tabs[0].id].title).toBe("new title");
  } finally {
    finishWrite.resolve();
    stopListening();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("unregistering layout persistence cancels a scheduled write", () => {
  const timer = fakeTimer();
  const beforeSave = mock(() => Promise.resolve());
  connectRenderer({ beforeSave });
  registerStatePersistence(timer);
  addTab({ type: "editor", props: { workspaceId, filePath: "/repo/never-saved.txt" } });

  unregisterStatePersistence();
  timer.run();
  expect(beforeSave).not.toHaveBeenCalled();
});
