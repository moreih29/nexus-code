/**
 * Scenario tests for git diff preview tab operations.
 *
 * Mirrors `commit-preview.test.ts` for the `openDiffTab` preview-slot path.
 * Covers:
 *   - reveal-existing (same diff opened twice in same group → single tab).
 *   - preview-slot reuse (single-click another file → slot swaps in place).
 *   - cross-group isolation (each group keeps its own preview slot).
 *   - promote-on-permanent (double-click reveals existing preview and promotes).
 *   - independence from editor and commit preview slots.
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

import {
  openDiffTab,
  openEditorTab,
  openOrRevealCommitTab,
} from "../../../../../src/renderer/state/operations/tabs";
import { useLayoutStore } from "../../../../../src/renderer/state/stores/layout";
import { findLeaf } from "../../../../../src/renderer/state/stores/layout/helpers";
import { useTabsStore } from "../../../../../src/renderer/state/stores/tabs";

const WS = "dddddddd-dddd-4ddd-dddd-dddddddddddd";
const SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function resetStores() {
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

function diffTabs() {
  return Object.values(useTabsStore.getState().byWorkspace[WS] ?? {}).filter(
    (tab) => tab.type === "editor.diff",
  );
}

describe("git diff preview operations", () => {
  beforeEach(resetStores);

  it("creates the first diff tab as preview by default", () => {
    const tab = openDiffTab(WS, "src/foo.ts", "HEAD", "WORKING");
    expect(tabRecord(tab.id)).toMatchObject({
      type: "editor.diff",
      isPreview: true,
      props: { relPath: "src/foo.ts", leftRef: "HEAD", rightRef: "WORKING" },
    });
  });

  it("creates a permanent diff tab when preview is opted out", () => {
    const tab = openDiffTab(WS, "src/foo.ts", "HEAD", "WORKING", undefined, { preview: false });
    expect(tabRecord(tab.id)).toMatchObject({
      type: "editor.diff",
      isPreview: false,
    });
  });

  it("reveals an existing diff tab when the same diff is opened again", () => {
    const first = openDiffTab(WS, "src/foo.ts", "HEAD", "WORKING");
    const second = openDiffTab(WS, "src/foo.ts", "HEAD", "WORKING");
    expect(second.id).toBe(first.id);
    expect(diffTabs()).toHaveLength(1);
  });

  it("treats different ref pairs of the same path as distinct diffs", () => {
    // HEAD..WORKING and INDEX..WORKING are two different views of the same file.
    // The preview slot is shared, so the second open replaces the first slot.
    const first = openDiffTab(WS, "src/foo.ts", "HEAD", "WORKING");
    const second = openDiffTab(WS, "src/foo.ts", "INDEX", "WORKING");
    expect(second.id).toBe(first.id); // slot reused
    expect(tabRecord(second.id)).toMatchObject({
      props: { leftRef: "INDEX", rightRef: "WORKING" },
      isPreview: true,
    });
    expect(diffTabs()).toHaveLength(1);
  });

  it("reuses the preview slot for a different file (file-tree parity)", () => {
    const first = openDiffTab(WS, "src/foo.ts", "HEAD", "WORKING");
    const second = openDiffTab(WS, "src/bar.ts", "HEAD", "WORKING");
    expect(second.id).toBe(first.id);
    expect(tabRecord(second.id)).toMatchObject({
      props: { relPath: "src/bar.ts" },
      isPreview: true,
    });
    expect(diffTabs()).toHaveLength(1);
  });

  it("keeps each group's preview slot independent across splits", () => {
    useLayoutStore.getState().ensureLayout(WS);
    const groupAId = getLayout().activeGroupId;
    const firstA = openDiffTab(WS, "a/one.ts", "HEAD", "WORKING", undefined, {
      groupId: groupAId,
    });

    const groupBId = useLayoutStore.getState().splitGroup(WS, groupAId, "horizontal", "after");
    const firstB = openDiffTab(WS, "b/one.ts", "HEAD", "WORKING", undefined, {
      groupId: groupBId,
    });

    const secondA = openDiffTab(WS, "a/two.ts", "HEAD", "WORKING", undefined, {
      groupId: groupAId,
    });
    const secondB = openDiffTab(WS, "b/two.ts", "HEAD", "WORKING", undefined, {
      groupId: groupBId,
    });

    expect(secondA.id).toBe(firstA.id);
    expect(secondB.id).toBe(firstB.id);
    expect(secondA.id).not.toBe(secondB.id);
    expect(findLeaf(getLayout().root, groupAId)?.tabIds).toEqual([secondA.id]);
    expect(findLeaf(getLayout().root, groupBId)?.tabIds).toEqual([secondB.id]);
  });

  it("promotes the existing preview when the same diff is opened with preview=false", () => {
    const preview = openDiffTab(WS, "src/foo.ts", "HEAD", "WORKING");
    expect(tabRecord(preview.id)).toMatchObject({ isPreview: true });

    const promoted = openDiffTab(WS, "src/foo.ts", "HEAD", "WORKING", undefined, {
      preview: false,
    });
    expect(promoted.id).toBe(preview.id);
    expect(tabRecord(promoted.id)).toMatchObject({ isPreview: false });
    expect(diffTabs()).toHaveLength(1);
  });

  it("preserves a promoted diff tab when a different preview diff is opened", () => {
    const promoted = openDiffTab(WS, "src/foo.ts", "HEAD", "WORKING", undefined, {
      preview: false,
    });
    expect(tabRecord(promoted.id)).toMatchObject({ isPreview: false });

    const nextPreview = openDiffTab(WS, "src/bar.ts", "HEAD", "WORKING");
    expect(nextPreview.id).not.toBe(promoted.id);
    expect(tabRecord(promoted.id)).toMatchObject({
      props: { relPath: "src/foo.ts" },
      isPreview: false,
    });
    expect(tabRecord(nextPreview.id)).toMatchObject({
      props: { relPath: "src/bar.ts" },
      isPreview: true,
    });
    expect(diffTabs()).toHaveLength(2);
  });

  it("evicts a clean editor preview slot when a diff preview opens (unified slot)", () => {
    useLayoutStore.getState().ensureLayout(WS);
    const groupId = getLayout().activeGroupId;
    const editor = openEditorTab(
      WS,
      { workspaceId: WS, filePath: "/repo/src/app.ts" },
      { groupId },
      true,
    );

    const diff = openDiffTab(WS, "src/foo.ts", "HEAD", "WORKING", undefined, { groupId });

    // Editor preview was clean → closed. Diff preview takes its leaf slot.
    expect(tabRecord(editor.id)).toBeUndefined();
    expect(tabRecord(diff.id)).toMatchObject({ type: "editor.diff", isPreview: true });
    expect(findLeaf(getLayout().root, groupId)?.tabIds).toEqual([diff.id]);
  });

  it("evicts a commit preview slot when a diff preview opens (unified slot)", () => {
    useLayoutStore.getState().ensureLayout(WS);
    const groupId = getLayout().activeGroupId;
    const commit = openOrRevealCommitTab(WS, SHA, { groupId });

    const diff = openDiffTab(WS, "src/foo.ts", "HEAD", "WORKING", undefined, { groupId });

    expect(tabRecord(commit.tabId)).toBeUndefined();
    expect(tabRecord(diff.id)).toMatchObject({ type: "editor.diff", isPreview: true });
    expect(findLeaf(getLayout().root, groupId)?.tabIds).toEqual([diff.id]);
  });

  it("inserts diff preview at the freed slot index, preserving surrounding tabs", () => {
    useLayoutStore.getState().ensureLayout(WS);
    const groupId = getLayout().activeGroupId;

    // permanent · clean-preview · permanent — diff preview must replace the
    // middle slot, not append.
    const left = openEditorTab(
      WS,
      { workspaceId: WS, filePath: "/repo/left.ts" },
      { groupId },
      false, // permanent
    );
    const middle = openEditorTab(
      WS,
      { workspaceId: WS, filePath: "/repo/middle.ts" },
      { groupId },
      true, // preview
    );
    const right = openEditorTab(
      WS,
      { workspaceId: WS, filePath: "/repo/right.ts" },
      { groupId },
      false, // permanent
    );
    expect(findLeaf(getLayout().root, groupId)?.tabIds).toEqual([left.id, middle.id, right.id]);

    const diff = openDiffTab(WS, "src/foo.ts", "HEAD", "WORKING", undefined, { groupId });
    expect(findLeaf(getLayout().root, groupId)?.tabIds).toEqual([left.id, diff.id, right.id]);
    expect(tabRecord(middle.id)).toBeUndefined();
  });
});
