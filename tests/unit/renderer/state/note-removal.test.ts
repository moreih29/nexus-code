import { expect, test } from "bun:test";
import { startNoteRemovalListener } from "../../../../src/renderer/state/note-removal";
import { openOrRevealNoteTab } from "../../../../src/renderer/state/operations/tabs";
import { useLayoutStore } from "../../../../src/renderer/state/stores/layout";
import { useTabsStore } from "../../../../src/renderer/state/stores/tabs";
import type { NoteChanged } from "../../../../src/shared/types/notes";

test("removing a notes location closes only tabs in the affected workspaces", async () => {
  const savedWindow = globalThis.window;
  const workspaces = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
  const [removed, task, other] = workspaces;
  const tabs = workspaces.map((id) => openOrRevealNoteTab(id, `note-${id}`).tabId);
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
    // Settle the obsolete path's read and error handler before checking the tabs.
    await failure.promise.catch(() => {});
    for (let i = 0; i < 4; i++) await Promise.resolve();

    const { byWorkspace } = useTabsStore.getState();
    expect(byWorkspace[other]?.[tabs[2]]?.type).toBe("note");
    expect(byWorkspace[removed]?.[tabs[0]]).toBeUndefined();
    expect(byWorkspace[task]?.[tabs[1]]).toBeUndefined();
  } finally {
    unlisten();
    for (const id of workspaces) {
      useTabsStore.getState().closeAllForWorkspace(id);
      useLayoutStore.getState().closeAllForWorkspace(id);
    }
    Object.assign(globalThis, { window: savedWindow });
  }
});
