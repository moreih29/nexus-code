import { afterEach, expect, spyOn, test } from "bun:test";
import { registerFileCommands } from "../../../../../src/renderer/commands/domains/file";
import { registerPaletteCommands } from "../../../../../src/renderer/commands/domains/palette";
import { registerTabCommands } from "../../../../../src/renderer/commands/domains/tab";
import { registerTerminalCommands } from "../../../../../src/renderer/commands/domains/terminal";
import { registerWorkspaceCommands } from "../../../../../src/renderer/commands/domains/workspace";
import { executeCommand } from "../../../../../src/renderer/commands/registry";
import * as ipc from "../../../../../src/renderer/ipc/client";
import {
  focusWorkspace,
  returnFromPeerWorkspace,
  selectPeerWorkspace,
} from "../../../../../src/renderer/state/operations/workspace-selection";
import { useActiveStore } from "../../../../../src/renderer/state/stores/active";
import { useAgentViewStore } from "../../../../../src/renderer/state/stores/agent-view";
import { useFilesStore } from "../../../../../src/renderer/state/stores/files";
import { useLayoutStore } from "../../../../../src/renderer/state/stores/layout/store";
import {
  type PeerWorkspaceTarget,
  peerTargetId,
  usePeerWorkspaceStore,
} from "../../../../../src/renderer/state/stores/peer-workspace";
import { useTabsStore } from "../../../../../src/renderer/state/stores/tabs";
import { useUIStore } from "../../../../../src/renderer/state/stores/ui";
import { isWorkspaceSymbolPaletteOpen } from "../../../../../src/renderer/state/stores/workspace-symbol-palette";
import { useWorkspacesStore } from "../../../../../src/renderer/state/stores/workspaces";
import { ipcOk } from "../../../../../src/shared/ipc/result";
import { COMMANDS } from "../../../../../src/shared/keybindings/commands";
import type { WorkspaceMeta } from "../../../../../src/shared/types/workspace";

const local = "123e4567-e89b-12d3-a456-426614174000";
const target: PeerWorkspaceTarget = {
  accountKey: "account",
  deviceName: "Desktop",
  deviceId: "desktop",
  platform: "darwin",
  workspaceId: "w1",
  workspace: { id: "w1", name: "Workspace", path: "/w" },
};
const id = peerTargetId(target);
const stores = [
  useActiveStore,
  useAgentViewStore,
  usePeerWorkspaceStore,
  useWorkspacesStore,
] as const;
const restore = stores.map((store) => {
  const before = store.getState();
  return () => store.setState(before as never, true);
});
afterEach(() => {
  for (const reset of restore) reset();
});

test("peer choices keep their tabs and tree while local selection and persistence stay separate", () => {
  const call = spyOn(ipc, "ipcCallResult").mockResolvedValue(ipcOk(undefined));
  const registered = [
    ...registerFileCommands(),
    ...registerPaletteCommands(),
    ...registerTabCommands(),
    ...registerTerminalCommands(),
    ...registerWorkspaceCommands(),
  ];
  try {
    const mode = useUIStore.getState().filesPanelModes;
    const layout = useLayoutStore.getState().byWorkspace;
    const tabs = useTabsStore.getState().byWorkspace;
    const tree = useFilesStore.getState().trees;
    useWorkspacesStore.setState({ workspaces: [{ id: local } as WorkspaceMeta] });
    focusWorkspace(local, "workspace");
    selectPeerWorkspace(target);
    const store = usePeerWorkspaceStore.getState();
    store.openFile(id, "/w/a.txt");
    store.openFile(id, "/w/b.txt");
    store.openFile(id, "/w/a.txt");
    store.closeFile(id, "/w/a.txt");
    store.setFolder(id, "/w", { path: "/w", entries: [] });
    store.toggleFolder(id, "/w/src");
    expect(useActiveStore.getState().activeWorkspaceId).toBeNull();

    for (const command of [
      COMMANDS.terminalNew,
      COMMANDS.fileSave,
      COMMANDS.tabClose,
      COMMANDS.fileNew,
      COMMANDS.workspaceFocusNext,
      COMMANDS.sessionNextWaiting,
      COMMANDS.workspaceSymbolSearch,
    ])
      executeCommand(command);

    expect(isWorkspaceSymbolPaletteOpen()).toBe(false);
    expect(useActiveStore.getState().activeWorkspaceId).toBeNull();
    expect(useLayoutStore.getState().byWorkspace).toBe(layout);
    expect(useTabsStore.getState().byWorkspace).toBe(tabs);
    expect(useFilesStore.getState().trees).toBe(tree);
    expect(useUIStore.getState().filesPanelModes).toBe(mode);
    expect(call).not.toHaveBeenCalled();

    selectPeerWorkspace({ ...target, deviceId: "other" });
    returnFromPeerWorkspace();
    expect(useActiveStore.getState().activeWorkspaceId).toBe(local);
    expect(usePeerWorkspaceStore.getState().active).toBeNull();
    selectPeerWorkspace(target);
    expect(usePeerWorkspaceStore.getState().views[id]).toMatchObject({
      tabs: [{ type: "peer.file", path: "/w/b.txt" }],
      activePath: "/w/b.txt",
      expanded: new Set(["/w/src"]),
      folders: { "/w": { path: "/w", entries: [] } },
    });
  } finally {
    for (const off of registered) off();
    call.mockRestore();
  }
});

test("a vanished workspace clears its view and restores the last existing local selection", () => {
  useWorkspacesStore.setState({
    workspaces: [{ id: local, location: { kind: "local", rootPath: "/local" } } as WorkspaceMeta],
  });
  focusWorkspace("removed-local", "workspace");
  selectPeerWorkspace(target);
  const store = usePeerWorkspaceStore.getState();
  store.openFile(id, "/w/a.txt");
  store.markMissing("another-peer");
  expect(usePeerWorkspaceStore.getState().missing).toBe(false);
  store.markMissing(id);
  expect(usePeerWorkspaceStore.getState().missing).toBe(true);
  expect(usePeerWorkspaceStore.getState().views[id]).toBeUndefined();
  expect(useActiveStore.getState().activeWorkspaceId).toBeNull();
  returnFromPeerWorkspace();
  expect(useActiveStore.getState().activeWorkspaceId).toBe(local);
});
