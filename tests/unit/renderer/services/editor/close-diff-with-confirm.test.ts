/**
 * closeDiffWithConfirm — a diff against the working tree edits the file, so
 * closing the last tab that shows its unsaved edits asks first.
 */
import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { cacheUriFor } from "../../../../../src/renderer/services/editor/model/cache";
import {
  __resetDirtyTrackerForTests,
  attachDirtyTracker,
} from "../../../../../src/renderer/services/editor/model/dirty-tracker";
import { useTabsStore } from "../../../../../src/renderer/state/stores/tabs";
import { useWorkspacesStore } from "../../../../../src/renderer/state/stores/workspaces";

const DIALOG_PATH = `${import.meta.dir}/../../../../../src/renderer/components/editor/save-confirm-dialog`;
const realDialog = await import(DIALOG_PATH);
let choice: "save" | "dont-save" | "cancel" = "cancel";
let prompts = 0;
mock.module(DIALOG_PATH, () => ({
  ...realDialog,
  showSaveConfirm: async () => {
    prompts += 1;
    return choice;
  },
}));

const { closeDiffWithConfirm } = await import(
  "../../../../../src/renderer/services/editor/save/close-handler"
);

const WS = "11111111-1111-4111-1111-111111111111";

function openDiff(rightRef = "WORKING"): string {
  return useTabsStore.getState().createTab(WS, {
    type: "editor.diff",
    props: { workspaceId: WS, relPath: "a.ts", leftRef: "INDEX", rightRef },
  }).id;
}

function makeFileDirty(): void {
  let altId = 1;
  const listeners = new Set<() => void>();
  attachDirtyTracker({
    cacheUri: cacheUriFor(WS, "/repo/a.ts"),
    model: {
      getAlternativeVersionId: () => altId,
      onDidChangeContent: (cb: () => void) => {
        listeners.add(cb);
        return { dispose: () => listeners.delete(cb) };
      },
    } as never,
    loadedMtime: "T0",
    loadedSize: 0,
  });
  altId = 2;
  for (const cb of listeners) cb();
}

const isOpen = (tabId: string) => useTabsStore.getState().byWorkspace[WS]?.[tabId] !== undefined;

beforeEach(() => {
  useTabsStore.setState({ byWorkspace: {} });
  useWorkspacesStore.setState({ workspaces: [{ id: WS, rootPath: "/repo" } as never] });
  __resetDirtyTrackerForTests();
  choice = "cancel";
  prompts = 0;
});

afterAll(() => {
  useWorkspacesStore.setState({ workspaces: [] });
  __resetDirtyTrackerForTests();
});

describe("closeDiffWithConfirm", () => {
  it("closes a diff of a clean file without asking", async () => {
    const tabId = openDiff();
    expect(await closeDiffWithConfirm(WS, tabId)).toBe("closed");
    expect(isOpen(tabId)).toBe(false);
    expect(prompts).toBe(0);
  });

  it("asks before dropping the unsaved edits only it shows", async () => {
    const tabId = openDiff();
    makeFileDirty();

    expect(await closeDiffWithConfirm(WS, tabId)).toBe("cancelled");
    expect(isOpen(tabId)).toBe(true);

    choice = "dont-save";
    expect(await closeDiffWithConfirm(WS, tabId)).toBe("closed");
    expect(isOpen(tabId)).toBe(false);
    expect(prompts).toBe(2);
  });

  it("closes without asking while an editor tab keeps the edits", async () => {
    const tabId = openDiff();
    useTabsStore.getState().createTab(WS, {
      type: "editor",
      props: { workspaceId: WS, filePath: "/repo/a.ts" },
    });
    makeFileDirty();

    expect(await closeDiffWithConfirm(WS, tabId)).toBe("closed");
    expect(prompts).toBe(0);
  });

  it("never asks for a staged diff, which edits nothing", async () => {
    const tabId = openDiff("INDEX");
    makeFileDirty();

    expect(await closeDiffWithConfirm(WS, tabId)).toBe("closed");
    expect(prompts).toBe(0);
  });
});
