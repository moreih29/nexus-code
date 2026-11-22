import { afterEach, expect, spyOn, test } from "bun:test";
import type { RemoteSession } from "../../../../../packages/remote-protocol/src/rpc";
import { registerFileCommands } from "../../../../../src/renderer/commands/domains/file";
import { registerPaletteCommands } from "../../../../../src/renderer/commands/domains/palette";
import { registerTabCommands } from "../../../../../src/renderer/commands/domains/tab";
import { registerTerminalCommands } from "../../../../../src/renderer/commands/domains/terminal";
import { registerWorkspaceCommands } from "../../../../../src/renderer/commands/domains/workspace";
import { executeCommand } from "../../../../../src/renderer/commands/registry";
import { openPeerWorkspaceFileBeside } from "../../../../../src/renderer/components/peer-workspace/session-placement";
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
  peerTabId,
  peerTargetId,
  usePeerWorkspaceStore,
} from "../../../../../src/renderer/state/stores/peer-workspace";
import { useTabsStore } from "../../../../../src/renderer/state/stores/tabs";
import { useUIStore } from "../../../../../src/renderer/state/stores/ui";
import { isWorkspaceSymbolPaletteOpen } from "../../../../../src/renderer/state/stores/workspace-symbol-palette";
import { useWorkspacesStore } from "../../../../../src/renderer/state/stores/workspaces";
import { ipcErr, ipcOk } from "../../../../../src/shared/ipc/result";
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
    store.closeTab(id, "/w/a.txt");
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

test("file, staged comparison, and unstaged comparison tabs have separate identities", () => {
  const store = usePeerWorkspaceStore.getState();
  store.select(target, null);
  const change = { path: "a.txt", staged: "A", unstaged: "M" };
  store.openFile(id, "/w/a.txt");
  store.openDiff(id, change, "staged");
  store.openDiff(id, change, "unstaged");
  store.openDiff(id, change, "unstaged");
  const view = usePeerWorkspaceStore.getState().views[id];
  expect(view.tabs).toHaveLength(3);
  const [file, staged, unstaged] = view.tabs.map(peerTabId);
  expect(new Set([file, staged, unstaged]).size).toBe(3);
  expect(view.activePath).toBe(unstaged);
  store.closeTab(id, unstaged);
  expect(usePeerWorkspaceStore.getState().views[id].activePath).toBe(staged);
  store.selectTab(id, file);
  expect(usePeerWorkspaceStore.getState().views[id].activePath).toBe(file);
});

test("shared Git status retains the last data on disconnect and clears it for a non-repository", () => {
  const store = usePeerWorkspaceStore.getState();
  store.select(target, null);
  const status = { branch: "main", ahead: 0, behind: 0, files: [] };
  store.setGitResult(id, ipcOk(status));
  store.setGitResult(id, ipcErr("unavailable", "disconnected"));
  expect(usePeerWorkspaceStore.getState().views[id]).toMatchObject({
    gitStatus: status,
    gitError: "unavailable",
  });
  store.setGitResult(id, ipcErr("not-found", "no repository"));
  expect(usePeerWorkspaceStore.getState().views[id]).toMatchObject({
    gitStatus: undefined,
    gitError: "not-found",
  });
});

test("a commit is one in-memory tab per hash in the selected peer workspace", () => {
  const store = usePeerWorkspaceStore.getState();
  store.select(target, null);
  const commit = { hash: "0123456789abcdef", subject: "Add notes" };
  store.openFile(id, "/w/a.txt");
  store.openCommit(id, commit);
  store.openCommit(id, commit);
  const view = usePeerWorkspaceStore.getState().views[id];
  const tab = { type: "peer.commit", ...commit } as const;
  const tabId = peerTabId(tab);
  expect(view.tabs).toEqual([{ type: "peer.file", path: "/w/a.txt" }, tab]);
  expect(view.activePath).toBe(tabId);

  const other = { ...target, deviceId: "other" };
  store.select(other, null);
  store.openCommit(id, { hash: "fedcba9876543210", subject: "Late action" });
  expect(usePeerWorkspaceStore.getState().views[peerTargetId(other)]).toBeUndefined();
  store.select(target, null);
  expect(usePeerWorkspaceStore.getState().views[id].tabs).toHaveLength(2);
  store.closeTab(id, tabId);
  expect(usePeerWorkspaceStore.getState().views[id].activePath).toBe("/w/a.txt");
});

const listedChat: RemoteSession = {
  kind: "claude",
  workspaceId: target.workspaceId,
  tabId: "chat",
  title: "Review",
  state: "idle",
  cwd: "/w/chat",
  profile: "Work",
};
const shell: RemoteSession = {
  kind: "terminal",
  workspaceId: target.workspaceId,
  tabId: "shell",
  title: "zsh",
  state: "idle",
};

test("workspace sessions follow the listed order, keep local hides, and prune gone tabs on reopen", () => {
  const store = usePeerWorkspaceStore.getState();
  const view = () => usePeerWorkspaceStore.getState().views[id]!;
  const keys = () => view().tabs.map(peerTabId);
  const chatKey = JSON.stringify(["peer.session", "chat"]);
  const shellKey = JSON.stringify(["peer.session", "shell"]);
  const nextKey = JSON.stringify(["peer.session", "next"]);
  const next = { ...listedChat, tabId: "next", title: "New" };
  const elsewhere = { ...listedChat, tabId: "z", workspaceId: "elsewhere" };
  const ipcCall = spyOn(ipc, "ipcCallResult");
  try {
    store.select(target, null);
    store.syncSessions(target, [listedChat, elsewhere, shell], false);
    expect(keys()).toEqual([chatKey, shellKey]);
    expect(view().activePath).toBe(chatKey);
    const shellTarget = view().tabs.find(
      (tab) => tab.type === "peer.session" && tab.target.tabId === "shell",
    );
    if (shellTarget?.type !== "peer.session") throw new Error("Expected a terminal tab");

    store.closeTab(id, shellKey);
    store.openFile(id, "/w/notes.txt");
    const renamed = { ...target, workspace: { ...target.workspace, name: "Renamed" } };
    store.syncSessions(
      renamed,
      [next, shell, { ...listedChat, title: "Updated", cwd: undefined, profile: undefined }],
      false,
    );
    expect(keys()).toEqual([chatKey, "/w/notes.txt", nextKey]);
    expect(view().tabs[0]).toMatchObject({
      target: { title: "Updated", profile: "Work", workspaceName: "Renamed" },
    });
    expect(view().tabs[0]).not.toHaveProperty("target.cwd");
    expect(view().sessions.map((session) => session.tabId)).toEqual(["next", "shell", "chat"]);

    store.openSession(id, shellTarget.target);
    expect(keys()).toEqual([chatKey, "/w/notes.txt", nextKey, shellKey]);
    expect(view().activePath).toBe(shellKey);
    store.closeTab(id, shellKey);
    store.syncSessions(target, [next], true);
    expect(view().tabs[0]).not.toHaveProperty("gone");
    expect(view().sessions.map((session) => session.tabId)).toEqual(["next", "shell", "chat"]);
    store.syncSessions(target, [shell, next], false);
    expect(view().tabs[0]).toMatchObject({ gone: true });
    store.selectTab(id, chatKey);
    store.clearSelection();
    store.select(target, null);
    expect(keys()).toEqual(["/w/notes.txt", nextKey]);
    expect(view().activePath).toBe("/w/notes.txt");
    store.syncSessions(target, [shell, next], false);
    expect(keys()).toEqual(["/w/notes.txt", nextKey]);
    expect(ipcCall).not.toHaveBeenCalled();
  } finally {
    ipcCall.mockRestore();
  }
});

test("a newly created tab survives a stale list and tracks terminal requests once listed", () => {
  const store = usePeerWorkspaceStore.getState();
  const view = () => usePeerWorkspaceStore.getState().views[id]!;
  store.select(target, null);
  store.openSession(id, {
    deviceId: target.deviceId,
    deviceName: target.deviceName,
    workspaceId: target.workspaceId,
    workspaceName: target.workspace.name,
    path: target.workspace.path,
    tabId: shell.tabId,
    kind: "terminal",
    title: "Starting",
  });
  store.syncSessions(target, [], false);
  expect(view().tabs[0]).toMatchObject({ pending: true });
  store.syncSessions(
    target,
    [
      {
        ...shell,
        waiting: {
          kind: "permission",
          text: "Run command",
          requestId: "req",
          always: true,
          subagent: false,
        },
      },
    ],
    false,
  );
  expect(view().tabs[0]).not.toHaveProperty("pending");
  expect(view().tabs[0]).toMatchObject({
    target: {
      title: "zsh",
      ask: { requestId: "req", text: "Run command", always: true, subagent: false },
    },
  });
  store.syncSessions(target, [shell], false);
  expect(view().tabs[0]).not.toHaveProperty("target.ask");
  store.syncSessions(target, [], false);
  expect(view().tabs[0]).toMatchObject({ gone: true });
});

test("open beside selects a read-only peer file at the chat link's line", () => {
  selectPeerWorkspace(target);
  expect(openPeerWorkspaceFileBeside(target, "/w/docs/start.md", { line: 4, column: 3 })).toBe(
    true,
  );
  expect(usePeerWorkspaceStore.getState().views[id]).toMatchObject({
    tabs: [{ type: "peer.file", path: "/w/docs/start.md", at: { line: 4, column: 3 } }],
    activePath: "/w/docs/start.md",
  });
  expect(useAgentViewStore.getState().mode).toBe("workspace");
  expect(openPeerWorkspaceFileBeside({ ...target, accountKey: "other" }, "/w/docs/start.md")).toBe(
    false,
  );
});
