import { expect, jest, spyOn, test } from "bun:test";
import { initFocusResync } from "../../../../../src/renderer/state/operations/focus-resync";
import { useActiveStore } from "../../../../../src/renderer/state/stores/active";
import { useFilesStore } from "../../../../../src/renderer/state/stores/files/store";
import { useWorkspacesStore } from "../../../../../src/renderer/state/stores/workspaces";
import * as workspaceCleanup from "../../../../../src/renderer/state/workspace-cleanup";
import type { WorkspaceMeta } from "../../../../../src/shared/types/workspace";

/** Restores a workspace and a loaded root that focus can refresh. */
function restoreWorkspace(id: string): void {
  const rootPath = "/project";
  const workspace: WorkspaceMeta = {
    id,
    name: id,
    rootPath,
    location: { kind: "local", rootPath },
    pinned: false,
    color: "auto",
    tabs: [],
  };
  useWorkspacesStore.getState().upsert(workspace);
  useFilesStore.getState().initTree(id, rootPath, []);
  useFilesStore.getState().setChildren(id, rootPath, []);
}

test("workspace removal forgets focus resyncs even when focus arrives after removal", () => {
  const { window: originalWindow, document: originalDocument } = globalThis;
  const originalActiveId = useActiveStore.getState().activeWorkspaceId;
  const originalWorkspaces = useWorkspacesStore.getState();
  const originalFiles = useFilesStore.getState();
  const select = useActiveStore.getState().setActiveWorkspaceId;
  const subscribe = useActiveStore.subscribe;
  let unsubscribe: (() => void) | undefined;
  const subscription = spyOn(useActiveStore, "subscribe").mockImplementation((listener) => {
    unsubscribe = subscribe(listener);
    return unsubscribe;
  });

  const ordinary = crypto.randomUUID();
  const late = crypto.randomUUID();
  const reads: string[] = [];
  let forgetFocus: workspaceCleanup.WorkspaceCleanupFn | undefined;
  const registration = spyOn(workspaceCleanup, "registerWorkspaceCleanup").mockImplementation(
    (cleanup) => {
      forgetFocus = cleanup;
      return () => {};
    },
  );
  const removeWorkspace = (id: string) => {
    useFilesStore.getState().closeAllForWorkspace(id);
    useWorkspacesStore.getState().remove(id);
    forgetFocus?.(id);
  };
  const fakeWindow = Object.assign(new EventTarget(), {
    ipc: {
      call: async (channel: string, method: string, { workspaceId }: { workspaceId: string }) => {
        if (channel === "fs" && method === "readdir") reads.push(workspaceId);
        return [];
      },
    },
  });
  Object.assign(globalThis, { window: fakeWindow, document: { hasFocus: () => false } });
  jest.useFakeTimers();
  try {
    initFocusResync();

    restoreWorkspace(ordinary);
    select(ordinary);
    removeWorkspace(ordinary);
    // Reuse the ID to observe whether the old throttle entry survived removal.
    restoreWorkspace(ordinary);
    select(null);
    select(ordinary);

    restoreWorkspace(late);
    select(late);
    fakeWindow.dispatchEvent(new Event("blur"));
    jest.advanceTimersByTime(2_001);
    removeWorkspace(late);
    // The active ID can still point at the removed workspace before React updates.
    fakeWindow.dispatchEvent(new Event("focus"));
    restoreWorkspace(late);
    select(null);
    select(late);

    expect(reads).toEqual([ordinary, ordinary, late, late]);
  } finally {
    unsubscribe?.();
    subscription.mockRestore();
    registration.mockRestore();
    removeWorkspace(ordinary);
    removeWorkspace(late);
    jest.useRealTimers();
    select(originalActiveId);
    useFilesStore.setState(originalFiles);
    useWorkspacesStore.setState(originalWorkspaces);
    Object.assign(globalThis, { window: originalWindow, document: originalDocument });
  }
});
