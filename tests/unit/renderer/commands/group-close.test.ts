/**
 * Close Group must not drop unsaved buffers: editor and untitled tabs go
 * through the dirty-aware close first, and a cancel or failed save keeps the
 * group open.
 */
import { beforeEach, describe, expect, it, mock } from "bun:test";

(globalThis as Record<string, unknown>).window = {
  ipc: { call: () => Promise.resolve(null), listen: () => {}, off: () => {} },
  matchMedia: (query: string) => ({
    matches: false,
    media: query,
    addEventListener(): void {},
    removeEventListener(): void {},
    addListener(): void {},
    removeListener(): void {},
  }),
};

let closeOutcome: "closed" | "cancelled" | "save-failed" = "closed";
const closeCalls: string[] = [];
// close-tab dispatches editor tabs to close-handler; mocking the handler (as
// bulk-close-cancel.test.ts does) keeps the real dispatcher in the chain and
// leaves close-tab unmocked for other test files.
const fakeClose = async (workspaceId: string, tabId: string) => {
  closeCalls.push(tabId);
  if (closeOutcome === "closed") {
    useLayoutStore.getState().detachTab(workspaceId, tabId);
    useTabsStore.getState().removeTab(workspaceId, tabId);
  }
  return closeOutcome;
};
mock.module(
  `${import.meta.dir}/../../../../src/renderer/services/editor/save/close-handler`,
  () => ({
    closeEditorWithConfirm: fakeClose,
    closeUntitledWithConfirm: fakeClose,
  }),
);

const { registerGroupCommands } = await import("../../../../src/renderer/commands/domains/group");
const { __resetCommandsForTests, executeCommand } = await import(
  "../../../../src/renderer/commands/registry"
);
const { useActiveStore } = await import("../../../../src/renderer/state/stores/active");
const { useLayoutStore } = await import("../../../../src/renderer/state/stores/layout");
const { findLeaf } = await import("../../../../src/renderer/state/stores/layout/helpers");
const { useTabsStore } = await import("../../../../src/renderer/state/stores/tabs");
const { COMMANDS } = await import("../../../../src/shared/keybindings/commands");

const WS = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";

function setUpSplitWithEditor() {
  useTabsStore.setState({ byWorkspace: {} });
  useLayoutStore.setState({ byWorkspace: {} });
  useLayoutStore.getState().ensureLayout(WS);
  const leftId = useLayoutStore.getState().byWorkspace[WS]!.activeGroupId;
  const rightId = useLayoutStore.getState().splitGroup(WS, leftId, "horizontal", "after");
  const editor = useTabsStore.getState().createTab(WS, {
    type: "editor",
    props: { workspaceId: WS, filePath: "/workspace/file.ts" },
  });
  useLayoutStore.getState().attachTab(WS, rightId, editor.id);
  useLayoutStore.getState().setActiveGroup(WS, rightId);
  useActiveStore.setState({ activeWorkspaceId: WS });
  return { rightId, editorId: editor.id };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const hasGroup = (groupId: string) =>
  findLeaf(useLayoutStore.getState().byWorkspace[WS]!.root, groupId) !== null;

describe("groupClose command", () => {
  beforeEach(() => {
    __resetCommandsForTests();
    registerGroupCommands();
    closeCalls.length = 0;
  });

  it("keeps the group and its editor when the save prompt is cancelled", async () => {
    const { rightId, editorId } = setUpSplitWithEditor();
    closeOutcome = "cancelled";

    executeCommand(COMMANDS.groupClose);
    await flush();

    expect(closeCalls).toEqual([editorId]);
    expect(hasGroup(rightId)).toBe(true);
    expect(useTabsStore.getState().byWorkspace[WS]?.[editorId]).toBeDefined();
  });

  it("keeps the group when saving the buffer fails", async () => {
    const { rightId, editorId } = setUpSplitWithEditor();
    closeOutcome = "save-failed";

    executeCommand(COMMANDS.groupClose);
    await flush();

    expect(hasGroup(rightId)).toBe(true);
    expect(useTabsStore.getState().byWorkspace[WS]?.[editorId]).toBeDefined();
  });

  it("closes the group once its buffers are closed", async () => {
    const { rightId } = setUpSplitWithEditor();
    closeOutcome = "closed";

    executeCommand(COMMANDS.groupClose);
    await flush();

    expect(hasGroup(rightId)).toBe(false);
  });
});
