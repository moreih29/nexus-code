import { expect, test } from "bun:test";
import { startNoteRemovalListener } from "../../../../src/renderer/state/note-removal";
import {
  openNewBrowserTab,
  openOrRevealNoteTab,
  revealTab,
} from "../../../../src/renderer/state/operations/tabs";
import { useLayoutStore } from "../../../../src/renderer/state/stores/layout";
import { useTabsStore } from "../../../../src/renderer/state/stores/tabs";
import type { NoteChanged } from "../../../../src/shared/types/notes";

test("removing a notes location closes affected note tabs and restores the last active survivor", async () => {
  const savedWindow = globalThis.window;
  const workspaces = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
  const [removed, task, other] = workspaces;
  const recent = openNewBrowserTab(removed);
  const older = openNewBrowserTab(removed);
  const tabs = workspaces.map((id) => openOrRevealNoteTab(id, `note-${id}`).tabId);
  const extra = openOrRevealNoteTab(removed, "another-note");
  revealTab(removed, extra.groupId, recent.id);
  revealTab(removed, extra.groupId, extra.tabId);
  let changed: ((event: NoteChanged) => void) | undefined;
  const failure = Promise.withResolvers<never>();
  void failure.promise.catch(() => {});
  Object.assign(globalThis, {
    window: {
      ipc: {
        listen: (_channel: string, _event: string, handler: typeof changed) => {
          changed = handler;
          return () => {};
        },
        call: () => failure.promise,
      },
    },
  });
  const unlisten = startNoteRemovalListener();
  try {
    if (!changed) throw new Error("missing notes change listener");
    changed({ locationKey: "local:/deleted", change: "removed", workspaceIds: [removed, task] });
    failure.reject(new Error("IPC disconnected"));
    await failure.promise.catch(() => {});
    for (let i = 0; i < 4; i++) await Promise.resolve();

    const { byWorkspace } = useTabsStore.getState();
    expect(byWorkspace[other]?.[tabs[2]]?.type).toBe("note");
    expect(byWorkspace[removed]?.[tabs[0]]).toBeUndefined();
    expect(byWorkspace[removed]?.[extra.tabId]).toBeUndefined();
    expect(byWorkspace[task]?.[tabs[1]]).toBeUndefined();
    expect(useLayoutStore.getState().byWorkspace[removed].root).toMatchObject({
      tabIds: [recent.id, older.id],
      activeTabId: recent.id,
    });
  } finally {
    unlisten();
    for (const id of workspaces) {
      useTabsStore.getState().closeAllForWorkspace(id);
      useLayoutStore.getState().closeAllForWorkspace(id);
    }
    Object.assign(globalThis, { window: savedWindow });
  }
});
