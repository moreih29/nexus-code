/**
 * Scenario tests for git commit preview tab operations.
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
  ipcCall: mock(() => Promise.resolve()),
  ipcListen: () => () => {},
}));

import {
  findCommitTab,
  openEditorTab,
  openOrRevealCommitTab,
  openTerminalTab,
} from "../../../../../src/renderer/state/operations/tabs";
import { useLayoutStore } from "../../../../../src/renderer/state/stores/layout";
import { allLeaves, findLeaf } from "../../../../../src/renderer/state/stores/layout/helpers";
import { useTabsStore } from "../../../../../src/renderer/state/stores/tabs";

const WS = "cccccccc-cccc-4ccc-cccc-cccccccccccc";
const SHA_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SHA_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const SHA_C = "cccccccccccccccccccccccccccccccccccccccc";
const SHA_D = "dddddddddddddddddddddddddddddddddddddddd";

/** Resets the two stores that commit tab operations coordinate. */
function resetStores() {
  useTabsStore.setState({ byWorkspace: {} });
  useLayoutStore.setState({ byWorkspace: {} });
}

/** Reads the current test workspace layout or fails the scenario early. */
function getLayout() {
  const layout = useLayoutStore.getState().byWorkspace[WS];
  if (!layout) throw new Error(`layout slice not found for ${WS}`);
  return layout;
}

/** Returns one tab record from the test workspace registry. */
function tabRecord(tabId: string) {
  return useTabsStore.getState().byWorkspace[WS]?.[tabId];
}

/** Lists commit tabs in the test workspace registry. */
function commitTabs() {
  return Object.values(useTabsStore.getState().byWorkspace[WS] ?? {}).filter(
    (tab) => tab.type === "git.commit",
  );
}

describe("git commit preview operations", () => {
  beforeEach(resetStores);

  it("reveals an existing commit tab when the same SHA is opened again", () => {
    const first = openOrRevealCommitTab(WS, SHA_A);
    openTerminalTab(WS, "terminal", { cwd: "/worktree" });

    const second = openOrRevealCommitTab(WS, SHA_A);

    expect(second).toEqual(first);
    expect(findCommitTab(WS, SHA_A)).toEqual(first);
    expect(commitTabs()).toHaveLength(1);
    const activeLeaf = findLeaf(getLayout().root, first.groupId);
    expect(activeLeaf?.activeTabId).toBe(first.tabId);
  });

  it("replaces only the targeted group's commit preview slot for a different SHA", () => {
    useLayoutStore.getState().ensureLayout(WS);
    const groupAId = getLayout().activeGroupId;
    const firstA = openOrRevealCommitTab(WS, SHA_A, { groupId: groupAId });
    const secondA = openOrRevealCommitTab(WS, SHA_B, { groupId: groupAId });

    const groupBId = useLayoutStore.getState().splitGroup(WS, groupAId, "horizontal", "after");
    const firstB = openOrRevealCommitTab(WS, SHA_C, { groupId: groupBId });
    const secondB = openOrRevealCommitTab(WS, SHA_D, { groupId: groupBId });

    expect(secondA.tabId).toBe(firstA.tabId);
    expect(secondB.tabId).toBe(firstB.tabId);
    expect(secondB.tabId).not.toBe(secondA.tabId);
    expect(tabRecord(secondA.tabId)).toMatchObject({
      type: "git.commit",
      props: { workspaceId: WS, sha: SHA_B },
      isPreview: true,
      title: `commit ${SHA_B.slice(0, 7)}`,
    });
    expect(tabRecord(secondB.tabId)).toMatchObject({
      type: "git.commit",
      props: { workspaceId: WS, sha: SHA_D },
      isPreview: true,
      title: `commit ${SHA_D.slice(0, 7)}`,
    });

    const leaves = allLeaves(getLayout().root);
    expect(findLeaf(getLayout().root, groupAId)?.tabIds).toEqual([secondA.tabId]);
    expect(findLeaf(getLayout().root, groupBId)?.tabIds).toEqual([secondB.tabId]);
    expect(leaves).toHaveLength(2);
  });

  it("preserves a promoted commit tab when a different preview commit is opened", () => {
    const preview = openOrRevealCommitTab(WS, SHA_A);
    const promoted = openOrRevealCommitTab(WS, SHA_A, { preview: false });

    const nextPreview = openOrRevealCommitTab(WS, SHA_B);

    expect(promoted.tabId).toBe(preview.tabId);
    expect(nextPreview.tabId).not.toBe(preview.tabId);
    expect(tabRecord(preview.tabId)).toMatchObject({
      type: "git.commit",
      props: { workspaceId: WS, sha: SHA_A },
      isPreview: false,
    });
    expect(tabRecord(nextPreview.tabId)).toMatchObject({
      type: "git.commit",
      props: { workspaceId: WS, sha: SHA_B },
      isPreview: true,
    });
    expect(commitTabs()).toHaveLength(2);
  });

  it("keeps editor preview slots independent from commit preview replacement", () => {
    useLayoutStore.getState().ensureLayout(WS);
    const groupId = getLayout().activeGroupId;
    const editor = openEditorTab(
      WS,
      { workspaceId: WS, filePath: "/repo/src/app.ts" },
      { groupId },
      true,
    );

    const commit = openOrRevealCommitTab(WS, SHA_A, { groupId });
    const replacedCommit = openOrRevealCommitTab(WS, SHA_B, { groupId });

    expect(replacedCommit.tabId).toBe(commit.tabId);
    expect(replacedCommit.tabId).not.toBe(editor.id);
    expect(tabRecord(editor.id)).toMatchObject({
      type: "editor",
      props: { workspaceId: WS, filePath: "/repo/src/app.ts" },
      isPreview: true,
    });
    expect(tabRecord(replacedCommit.tabId)).toMatchObject({
      type: "git.commit",
      props: { workspaceId: WS, sha: SHA_B },
      isPreview: true,
    });
    expect(findLeaf(getLayout().root, groupId)?.tabIds).toEqual([editor.id, replacedCommit.tabId]);
  });
});
