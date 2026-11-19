import { afterEach, expect, test } from "bun:test";
import { usePanelViewOptionsStore } from "../../../../../src/renderer/state/stores/panel-view-options";

const originalWindow = globalThis.window;
const workspaceId = "workspace-with-view-options";
const entryKey = `git:${workspaceId}`;

afterEach(() => {
  usePanelViewOptionsStore.getState().closeForWorkspace(workspaceId);
  usePanelViewOptionsStore.setState({ entries: new Map() });
  Object.assign(globalThis, { window: originalWindow });
});

/** Holds the saved view mode until the test delivers the IPC response. */
function holdViewOptionsRead() {
  const read = Promise.withResolvers<{ viewMode: "tree" }>();
  Object.assign(globalThis, {
    window: {
      ipc: { call: () => read.promise },
    },
  });
  return async () => {
    read.resolve({ viewMode: "tree" });
    await read.promise;
    // Drain the IPC envelope and store continuation.
    await Promise.resolve();
    await Promise.resolve();
  };
}

test("a slow view options read preserves the user's newer view mode", async () => {
  const finishRead = holdViewOptionsRead();
  const store = usePanelViewOptionsStore.getState();
  store.loadViewOptions("git", workspaceId);
  store.setViewMode("git", workspaceId, "list");

  await finishRead();

  expect(usePanelViewOptionsStore.getState().entries.get(entryKey)?.viewMode).toBe("list");
});

test("closing a workspace drops its view options and ignores its pending read", async () => {
  const finishRead = holdViewOptionsRead();
  const store = usePanelViewOptionsStore.getState();
  store.loadViewOptions("git", workspaceId);
  const otherWorkspace = "another-workspace";
  store.loadViewOptions("git", otherWorkspace);
  store.closeForWorkspace(workspaceId);

  await finishRead();

  const entries = usePanelViewOptionsStore.getState().entries;
  expect(entries.has(entryKey)).toBe(false);
  expect(entries.get(`git:${otherWorkspace}`)?.viewMode).toBe("tree");
});
