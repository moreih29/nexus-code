/**
 * Scenario test for the unified preview-slot policy when the slot currently
 * holds an editor with **unsaved (dirty) buffer**. Per VSCode parity, a dirty
 * editor preview must not be silently discarded — it gets promoted to a
 * permanent tab, and the new preview is inserted right after it.
 *
 * Other promote-vs-close branches (clean editor preview → close, diff/commit
 * preview → close) live in `diff-preview.test.ts` and `commit-preview.test.ts`.
 *
 * Bun's `mock.module` is GLOBAL across the test run; mocking dirty-tracker
 * here would break sibling dirty-tracker tests. So we drive dirty state
 * through the real `attachDirtyTracker` API with a minimal model stub.
 */
import { beforeEach, describe, expect, it, mock } from "bun:test";

(globalThis as Record<string, unknown>).window = {
  ipc: {
    call: () => Promise.resolve(null),
    listen: () => {},
    off: () => {},
  },
};

mock.module("../../../../../src/renderer/ipc/client", () => ({
  ipcCallResult: mock(() => Promise.resolve({ ok: true as const, value: undefined })),
  ipcListen: () => () => {},
}));

import type * as Monaco from "monaco-editor";
import { cacheUriFor } from "../../../../../src/renderer/services/editor/model/cache";
import {
  attachDirtyTracker,
  detachDirtyTracker,
  isDirty,
} from "../../../../../src/renderer/services/editor/model/dirty-tracker";
import { openDiffTab, openEditorTab } from "../../../../../src/renderer/state/operations/tabs";
import { useLayoutStore } from "../../../../../src/renderer/state/stores/layout";
import { findLeaf } from "../../../../../src/renderer/state/stores/layout/helpers";
import { useTabsStore } from "../../../../../src/renderer/state/stores/tabs";

const WS = "eeeeeeee-eeee-4eee-eeee-eeeeeeeeeeee";

/**
 * Minimal Monaco ITextModel stub for the dirty tracker. Tracks an
 * `alternativeVersionId` we can bump to simulate a user edit, and replays
 * the change to subscribers so `entry.isDirty` flips through the same code
 * path the real tracker drives. `simulateEdit` is the only test hook;
 * everything else mirrors the real model surface the tracker depends on.
 */
function makeFakeModel() {
  let altId = 1;
  const listeners: Array<() => void> = [];
  const model = {
    getAlternativeVersionId: () => altId,
    onDidChangeContent: (cb: () => void) => {
      listeners.push(cb);
      return { dispose: () => {} };
    },
  } as unknown as Monaco.editor.ITextModel;
  return {
    model,
    simulateEdit: () => {
      altId += 1;
      for (const cb of listeners) cb();
    },
  };
}

const trackedCacheUris = new Set<string>();
function resetStores() {
  for (const uri of trackedCacheUris) detachDirtyTracker(uri);
  trackedCacheUris.clear();
  useTabsStore.setState({ byWorkspace: {} });
  useLayoutStore.setState({ byWorkspace: {} });
}

function getLayout() {
  const layout = useLayoutStore.getState().byWorkspace[WS];
  if (!layout) throw new Error(`layout slice not found for ${WS}`);
  return layout;
}

function tabRecord(tabId: string) {
  return useTabsStore.getState().byWorkspace[WS]?.[tabId];
}

function markDirty(workspaceId: string, filePath: string) {
  const cacheUri = cacheUriFor(workspaceId, filePath);
  const { model, simulateEdit } = makeFakeModel();
  attachDirtyTracker({ cacheUri, model, loadedMtime: "", loadedSize: 0 });
  trackedCacheUris.add(cacheUri);
  simulateEdit();
  // sanity — confirm the real tracker now reports dirty for this uri.
  if (!isDirty(cacheUri)) throw new Error(`failed to mark ${cacheUri} dirty in test setup`);
}

describe("unified preview slot — dirty editor branch", () => {
  beforeEach(resetStores);

  it("promotes a dirty editor preview instead of closing it, inserting the new preview after", () => {
    useLayoutStore.getState().ensureLayout(WS);
    const groupId = getLayout().activeGroupId;

    const dirtyFilePath = "/repo/src/app.ts";
    const editor = openEditorTab(
      WS,
      { workspaceId: WS, filePath: dirtyFilePath },
      { groupId },
      true, // preview
    );
    markDirty(WS, dirtyFilePath);

    const diff = openDiffTab(WS, "src/foo.ts", "HEAD", "WORKING", undefined, { groupId });

    // Editor stays in place, but is now permanent (no longer preview).
    expect(tabRecord(editor.id)).toMatchObject({
      type: "editor",
      isPreview: false,
    });
    // Diff is the new preview, slotted right after the promoted editor.
    expect(tabRecord(diff.id)).toMatchObject({
      type: "editor.diff",
      isPreview: true,
    });
    expect(findLeaf(getLayout().root, groupId)?.tabIds).toEqual([editor.id, diff.id]);
  });

  it("closes a clean editor preview when a diff preview opens (no dirty buffer)", () => {
    useLayoutStore.getState().ensureLayout(WS);
    const groupId = getLayout().activeGroupId;

    const editor = openEditorTab(
      WS,
      { workspaceId: WS, filePath: "/repo/src/app.ts" },
      { groupId },
      true,
    );
    // No markDirty — buffer stays clean.

    const diff = openDiffTab(WS, "src/foo.ts", "HEAD", "WORKING", undefined, { groupId });

    expect(tabRecord(editor.id)).toBeUndefined();
    expect(findLeaf(getLayout().root, groupId)?.tabIds).toEqual([diff.id]);
  });
});
