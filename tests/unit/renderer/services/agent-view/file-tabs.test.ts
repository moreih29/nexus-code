import { afterEach, describe, expect, it } from "bun:test";
import { routeAgentViewCommand } from "../../../../../src/renderer/commands/domains/agent-view";
import { sessionKey } from "../../../../../src/renderer/services/agent-sessions/model";
import {
  placeLocalFile,
  showHeldLocalFile,
  showHeldRemoteFile,
} from "../../../../../src/renderer/services/agent-view/file-tabs";
import {
  activeKey,
  heldKeys,
  leafHolding,
  openKey,
  remoteSessionKey,
} from "../../../../../src/renderer/services/agent-view/layout";
import {
  startAgentViewPruning,
  tabExists,
} from "../../../../../src/renderer/services/agent-view/show";
import { cancelTabFocus } from "../../../../../src/renderer/services/tab-focus";
import { computeActiveContext } from "../../../../../src/renderer/state/claude-active-context-sync";
import { openEditorTab } from "../../../../../src/renderer/state/operations/tabs";
import {
  __resetAgentViewForTests,
  useAgentViewStore,
} from "../../../../../src/renderer/state/stores/agent-view";
import { useLayoutStore } from "../../../../../src/renderer/state/stores/layout";
import { useTabsStore } from "../../../../../src/renderer/state/stores/tabs";
import { remoteFileKey } from "../../../../../src/shared/fs/remote-file-key";
import { COMMANDS } from "../../../../../src/shared/keybindings/commands";

const WS = "project";
const FILE = "/project/readme.md";
const view = useAgentViewStore.getState();

afterEach(() => {
  __resetAgentViewForTests();
  useTabsStore.setState({ byWorkspace: {} });
  useLayoutStore.setState({ byWorkspace: {} });
  cancelTabFocus();
});

describe("file links in the agent view", () => {
  it("reuses and promotes an existing editor, and routes save and agent context by the active panel", () => {
    const session = useTabsStore
      .getState()
      .createTab(WS, { type: "claude", props: { cwd: "/project" } });
    const chat = sessionKey(WS, session.id);
    const editor = openEditorTab(WS, { workspaceId: WS, filePath: FILE }, undefined, true);
    const key = sessionKey(WS, editor.id);
    view.setMode("agents");
    view.update((layout) => openKey(layout, chat));
    expect(showHeldLocalFile(WS, FILE)).toBe(false);
    expect(routeAgentViewCommand(COMMANDS.fileSave)).toBe("skip");

    placeLocalFile(WS, session.id, FILE, true, { line: 7 });
    const placed = useAgentViewStore.getState();
    expect(placed.mode).toBe("agents");
    expect(heldKeys(placed.root)).toEqual([chat, key]);
    expect(Object.keys(useTabsStore.getState().byWorkspace[WS] ?? {})).toHaveLength(2);
    expect(useTabsStore.getState().byWorkspace[WS]?.[editor.id]?.isPreview).toBe(false);
    expect(routeAgentViewCommand(COMMANDS.fileSave)).toBeUndefined();
    expect(computeActiveContext()).toEqual({ workspaceId: null, tabId: null });

    // A second workspace split opens another copy. The panel's copy is still selected.
    const group = useLayoutStore.getState().byWorkspace[WS]?.activeGroupId;
    if (!group) throw new Error("workspace group is missing");
    useLayoutStore.getState().splitGroup(WS, group, "horizontal", "after");
    openEditorTab(WS, { workspaceId: WS, filePath: FILE });
    const next = openEditorTab(WS, { workspaceId: WS, filePath: "/project/next.md" });
    view.update((layout) => openKey(layout, sessionKey(WS, next.id), placed.activeLeafId));
    view.update((layout) => openKey(layout, chat));
    expect(computeActiveContext()).toEqual({ workspaceId: WS, tabId: session.id });
    expect(showHeldLocalFile(WS, FILE)).toBe(true);
    expect(activeKey(useAgentViewStore.getState())).toBe(key);

    const { root, activeLeafId } = useAgentViewStore.getState();
    view.hydrate({ mode: "agents", root, activeLeafId }, tabExists);
    expect(activeKey(useAgentViewStore.getState())).toBe(key);

    const stop = startAgentViewPruning();
    try {
      useTabsStore.getState().removeTab(WS, session.id);
      expect(leafHolding(useAgentViewStore.getState().root, key)).not.toBeNull();
      useTabsStore.getState().removeTab(WS, editor.id);
      expect(leafHolding(useAgentViewStore.getState().root, key)).toBeNull();
    } finally {
      stop();
    }
  });

  it("finds a held peer file by device, workspace and path and switches to the linked line", () => {
    const file = { deviceId: "mac", workspaceId: WS, path: FILE };
    const key = remoteFileKey(file);
    const chat = remoteSessionKey({ ...file, tabId: "chat" });
    view.setMode("agents");
    view.update((layout) => openKey(layout, chat));
    view.placeRemoteFile(key, chat, {
      deviceName: "Mac",
      workspaceRoot: "/project",
      mode: "preview",
    });
    const front = useAgentViewStore.getState().activeLeafId;
    const other = remoteFileKey({ ...file, path: "/project/other.md" });
    view.placeRemoteFile(other, chat, { deviceName: "Mac", workspaceRoot: "/project" });
    expect(showHeldRemoteFile({ ...file, deviceId: "another" })).toBe(false);
    expect(showHeldRemoteFile(file, { line: 8, column: 3 })).toBe(true);
    const state = useAgentViewStore.getState();
    expect(state.activeLeafId).toBe(front);
    expect(activeKey(state)).toBe(key);
    expect(state.remoteFiles.get(key)).toMatchObject({ at: { line: 8, column: 3 }, mode: "raw" });
    expect(routeAgentViewCommand(COMMANDS.fileSave)).toBe("skip");
    expect(tabExists(key)).toBe(false);
    view.setMode("workspace");
    expect(showHeldRemoteFile(file)).toBe(false);
  });
});
