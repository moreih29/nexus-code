import { expect, spyOn, test } from "bun:test";
import { Tabs } from "radix-ui";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { RemoteSession } from "../../../../../packages/remote-protocol/src/rpc";
import { forkPeerChat } from "../../../../../src/renderer/components/agent-view/remote-chat-actions";
import { useRemoteLinks } from "../../../../../src/renderer/components/agent-view/remote-links";
import { RemoteSessionPane } from "../../../../../src/renderer/components/agent-view/remote-pane";
import { newPeerChat } from "../../../../../src/renderer/components/agent-view/remote-session-actions";
import type { RemoteSessionHost } from "../../../../../src/renderer/components/agent-view/remote-session-host";
import * as rows from "../../../../../src/renderer/components/agent-view/remote-sessions";
import { QuickLook } from "../../../../../src/renderer/components/chat/quick-look";
import { PeerWorkspacePanel } from "../../../../../src/renderer/components/peer-workspace/panel";
import {
  openPeerWorkspaceFileBeside,
  showPeerWorkspaceSession,
} from "../../../../../src/renderer/components/peer-workspace/session-placement";
import { PeerSessionTabBody } from "../../../../../src/renderer/components/peer-workspace/session-tab";
import { PeerSessionsPanel } from "../../../../../src/renderer/components/peer-workspace/sessions-panel";
import * as buttons from "../../../../../src/renderer/components/ui/icon-button";
import * as ipc from "../../../../../src/renderer/ipc/client";
import type { ChatFiles } from "../../../../../src/renderer/services/chat/chat-files";
import * as peerChat from "../../../../../src/renderer/services/remote/peer-chat";
import * as peerComposer from "../../../../../src/renderer/services/remote/peer-composer";
import * as peerTerminal from "../../../../../src/renderer/services/remote/peer-terminal";
import * as room from "../../../../../src/renderer/services/remote/room";
import { TerminalTyping } from "../../../../../src/renderer/services/remote/terminal-typing";
import { useAgentViewStore } from "../../../../../src/renderer/state/stores/agent-view";
import * as workspaceStore from "../../../../../src/renderer/state/stores/peer-workspace";
import { listedRemoteTarget } from "../../../../../src/renderer/state/stores/remote-view";
import { ipcOk } from "../../../../../src/shared/ipc/result";
import type { RoomPeer } from "../../../../../src/shared/remote/room";

// Render current client snapshots for hooks backed by the running workbench.
function clientSnapshots() {
  const useStore = React.useSyncExternalStore;
  return spyOn(React, "useSyncExternalStore").mockImplementation((subscribe, getSnapshot) =>
    useStore(subscribe, getSnapshot, getSnapshot),
  );
}

const { peerTargetId, usePeerWorkspaceStore } = workspaceStore;
type PeerWorkspaceTarget = workspaceStore.PeerWorkspaceTarget;

const peer = { id: "desktop", name: "Desktop", online: true, platform: "linux" };
const target: PeerWorkspaceTarget = {
  accountKey: "account",
  deviceId: peer.id,
  deviceName: peer.name,
  platform: peer.platform,
  workspaceId: "repo",
  workspace: { id: "repo", name: "Repo", path: "/repo" },
};
const shell: RemoteSession = {
  kind: "terminal",
  tabId: "shell",
  workspaceId: "repo",
  title: "zsh",
  state: "waiting",
  waiting: { kind: "permission", requestId: "ask", text: "Run tools?", always: false },
};
const host: RemoteSessionHost = {
  focusKey: "peer-workspace-test",
  openSession: () => {},
  openFileBeside: () => false,
  hideSession: () => {},
  onGone: () => {},
};

const readyChat: ReturnType<typeof peerChat.usePeerChat> = {
  read: {
    status: "ready",
    value: {
      status: {
        agent: "claude",
        title: "Review",
        process: "running",
        running: false,
        permissions: [{ requestId: "chat-ask", toolName: "Bash", input: { command: "pwd" } }],
        streaming: null,
        turn: null,
      },
      start: 0,
      total: 0,
      items: [],
      tools: {},
      tasks: {},
      agentItems: {},
    },
  },
  loadEarlier: () => {},
  loadingEarlier: false,
};

test("the workspace plus is the local tab bar's, with the agent list wherever that computer is reached", () => {
  const previous = usePeerWorkspaceStore.getState();
  usePeerWorkspaceStore.setState({ active: target, accountKey: target.accountKey, views: {} });
  const render = (computer?: RoomPeer) =>
    renderToStaticMarkup(
      <PeerWorkspacePanel
        target={target}
        peer={computer}
        shown
        reach={computer ? "online" : "offline"}
        reachable={computer !== undefined}
        missing={false}
        updateNeeded={false}
        gitUpdateNeeded={false}
        rejoin={0}
      />,
    );
  try {
    expect(render()).not.toContain('data-testid="remote-new-menu"');
    // Its menu lists the new sessions that computer lets this one open, then the agent list.
    for (const serves of [
      [],
      ["chat.read", "terminal.read"],
      ["chat.control"],
      ["terminal.control"],
    ]) {
      const html = render({ ...peer, serves });
      expect(html).toContain('data-testid="remote-new-menu"');
      expect(html).toContain('aria-label="New tab"');
      expect(html).toMatch(/class="[^"]*size-8[^"]*"[^>]*data-testid="remote-new-menu"/);
    }
  } finally {
    usePeerWorkspaceStore.setState(previous, true);
  }
});

test("a peer workspace chat and terminal stay readable with control capabilities off", () => {
  const chat = listedRemoteTarget(peer, target.workspace, { ...shell, kind: "claude" });
  const terminal = listedRemoteTarget(peer, target.workspace, shell);
  const snapshots = clientSnapshots();
  const readRoom = spyOn(room, "useRemoteRoom");
  const sessionList = spyOn(room, "usePeerSessions").mockReturnValue({});
  const chatRead = spyOn(peerChat, "usePeerChat").mockReturnValue(readyChat);
  const terminalRead = spyOn(peerTerminal, "usePeerTerminal").mockReturnValue({
    status: "ready",
    value: { text: "terminal output" },
  });
  try {
    const controls = (serves?: string[]) =>
      readRoom.mockReturnValue({ status: "online", peers: [{ ...peer, serves }] });
    const render = (session: typeof chat) =>
      renderToStaticMarkup(<RemoteSessionPane target={session} host={host} visible />);
    for (const serves of [undefined, ["chat.read", "terminal.read"]]) {
      controls(serves);
      const readChat = render(chat);
      expect(readChat).toContain('data-testid="remote-view-only"');
      expect(readChat).not.toContain('data-testid="chat-permission"');
      const read = render(terminal);
      expect(read).toContain("terminal output");
      expect(read).toContain('data-testid="remote-terminal-view-only"');
      expect(read).not.toContain('data-testid="remote-terminal-ask"');
    }
    controls(["chat.control"]);
    sessionList.mockReturnValue({
      [peer.id]: {
        status: "ready",
        list: {
          sessions: [shell],
          workspaces: [target.workspace],
          consents: [
            {
              id: "consent",
              at: 0,
              expiresAt: 30_000,
              expiresInMs: 30_000,
              from: { workspaceId: chat.workspaceId, tabId: chat.tabId },
              workspaceId: chat.workspaceId,
              change: { kind: "chatInput", detail: "Agent request" },
              eachTime: true,
              answerable: true,
            },
          ],
        },
      },
    });
    const controlledChat = render(chat);
    expect(controlledChat).not.toContain('data-testid="remote-consent"');
    expect(controlledChat).not.toContain('data-testid="remote-view-only"');
    expect(controlledChat).toContain('data-testid="chat-permission"');
    const terminalWithApproval = render(terminal);
    expect(terminalWithApproval).toContain('data-testid="remote-terminal-ask"');
    expect(terminalWithApproval).toContain('data-testid="remote-terminal-view-only"');
    controls(["terminal.control"]);
    const terminalWithInputOnly = render(terminal);
    expect(terminalWithInputOnly).not.toContain('data-testid="remote-terminal-ask"');
    expect(terminalWithInputOnly).not.toContain('data-testid="remote-terminal-view-only"');
  } finally {
    snapshots.mockRestore();
    readRoom.mockRestore();
    sessionList.mockRestore();
    chatRead.mockRestore();
    terminalRead.mockRestore();
  }
});

test("the agents list can bring a hidden shell back to the workspace's tabs", () => {
  const previous = usePeerWorkspaceStore.getState();
  const id = peerTargetId(target);
  const tab = JSON.stringify(["peer.session", shell.tabId]);
  const storeView = spyOn(workspaceStore, "usePeerWorkspaceStore");
  storeView.mockImplementation(
    Object.assign(
      <T,>(select: (state: typeof previous) => T) => select(usePeerWorkspaceStore.getState()),
      usePeerWorkspaceStore,
    ),
  );
  Object.assign(storeView, usePeerWorkspaceStore);
  const row = spyOn(rows, "RemoteSessionRow");
  try {
    previous.select(target, null);
    previous.syncSessions(target, [shell], false);
    previous.closeTab(id, tab);
    expect(usePeerWorkspaceStore.getState().views[id]?.tabs).toHaveLength(0);
    expect(renderToStaticMarkup(<PeerSessionsPanel target={target} peer={peer} />)).toContain(
      "zsh",
    );
    row.mock.calls[0]?.[0].onOpen?.();
    expect(usePeerWorkspaceStore.getState().views[id]).toMatchObject({
      tabs: [{ type: "peer.session", target: { tabId: shell.tabId } }],
      activePath: tab,
    });
  } finally {
    row.mockRestore();
    storeView.mockRestore();
    usePeerWorkspaceStore.setState(previous, true);
  }
});

test("remote chat quick look opens at the linked line in a workspace file tab", () => {
  const previous = usePeerWorkspaceStore.getState();
  const previousMode = useAgentViewStore.getState().mode;
  const id = peerTargetId(target);
  const snapshots = clientSnapshots();
  const icon = spyOn(buttons, "IconButton");
  const files = {} as ChatFiles;
  const doNothing = () => {};
  const file = "/repo/src/readme.md";
  function ChatLook() {
    const links = useRemoteLinks(
      listedRemoteTarget(peer, target.workspace, { ...shell, kind: "claude" }),
      { model: { items: [], tools: {}, agentItems: {} } },
      files,
      doNothing,
      (path, { at }) => openPeerWorkspaceFileBeside(target, path, at),
    );
    return (
      <QuickLook
        workspaceId={id}
        peerRoot={target.workspace.path}
        local={false}
        area={null}
        list={{ files: [file], index: 0, at: { path: file, line: 5, column: 2 } }}
        onIndex={doNothing}
        onClose={doNothing}
        openBesideInWorkspace
        onOpenBeside={links.openBeside}
      />
    );
  }
  try {
    previous.select(target, null);
    useAgentViewStore.getState().setMode("workspace");
    expect(renderToStaticMarkup(<ChatLook />)).toContain("chat-quick-look-open-beside");
    const beside = icon.mock.calls.find(
      ([props]) => props["data-testid"] === "chat-quick-look-open-beside",
    );
    beside?.[0].onClick?.({} as never);
    expect(usePeerWorkspaceStore.getState().views[id]).toMatchObject({
      tabs: [{ type: "peer.file", path: file, at: { line: 5, column: 2 } }],
      activePath: file,
    });
    expect(useAgentViewStore.getState().mode).toBe("workspace");
  } finally {
    snapshots.mockRestore();
    icon.mockRestore();
    usePeerWorkspaceStore.setState(previous, true);
    useAgentViewStore.getState().setMode(previousMode);
  }
});

test("terminal input in both views follows terminal.control even while a typing queue is retained", () => {
  const snapshots = clientSnapshots();
  const readRoom = spyOn(room, "useRemoteRoom");
  const lists = spyOn(room, "usePeerSessions").mockReturnValue({});
  const read = spyOn(peerTerminal, "usePeerTerminal").mockReturnValue({
    status: "ready",
    value: { text: "remote output" },
  });
  const typing = new TerminalTyping(
    async () => {},
    () => {},
  );
  const watch = spyOn(peerTerminal, "watchPeerTerminalTyping").mockImplementation((_, onTyping) => {
    onTyping(typing);
    return () => {};
  });
  // Commit the first layout effect (the terminal's typing subscription) once
  // per SSR render so the real screen sees a populated input queue.
  const layoutEffect = React.useLayoutEffect;
  let subscribed = false;
  const commitTyping = spyOn(React, "useLayoutEffect").mockImplementation((effect, deps) => {
    if (!subscribed) {
      subscribed = true;
      effect();
    }
    layoutEffect(effect, deps);
  });
  const terminal = listedRemoteTarget(peer, target.workspace, shell);
  try {
    for (const container of [host, undefined]) {
      for (const allowed of [false, true]) {
        subscribed = false;
        readRoom.mockReturnValue({
          status: "online",
          peers: [{ ...peer, serves: allowed ? ["terminal.control"] : ["terminal.read"] }],
        });
        const html = renderToStaticMarkup(
          <RemoteSessionPane target={terminal} visible host={container} />,
        );
        expect(html).toContain("remote output");
        expect(html.includes('data-testid="remote-terminal-input"')).toBe(allowed);
      }
    }
    expect(watch).toHaveBeenCalledTimes(4);
  } finally {
    commitTyping.mockRestore();
    watch.mockRestore();
    read.mockRestore();
    lists.mockRestore();
    readRoom.mockRestore();
    snapshots.mockRestore();
    typing.dispose();
  }
});

test("workspace /exit hides the selected chat without a remote close request", () => {
  const previous = usePeerWorkspaceStore.getState();
  const id = peerTargetId(target);
  const snapshots = clientSnapshots();
  const readRoom = spyOn(room, "useRemoteRoom").mockReturnValue({
    status: "online",
    peers: [{ ...peer, serves: ["chat.control"] }],
  });
  const lists = spyOn(room, "usePeerSessions").mockReturnValue({});
  const chatRead = spyOn(peerChat, "usePeerChat").mockReturnValue(readyChat);
  const composer = spyOn(peerComposer, "usePeerComposer");
  const call = spyOn(ipc, "ipcCallResult").mockResolvedValue(ipcOk(undefined));
  try {
    const chat = { ...shell, kind: "claude" as const, tabId: "chat", state: "idle" as const };
    previous.select(target, null);
    previous.syncSessions(target, [chat], false);
    const tab = usePeerWorkspaceStore.getState().views[id]?.tabs[0];
    if (tab?.type !== "peer.session") throw new Error("Expected a session tab");
    renderToStaticMarkup(
      <Tabs.Root value={encodeURIComponent(workspaceStore.peerTabId(tab))}>
        <PeerSessionTabBody workspace={target} tab={tab} shown selected />
      </Tabs.Root>,
    );
    const result = composer.mock.results.at(-1)?.value;
    expect(result?.onCommand("/exit")).toBe(true);
    expect(usePeerWorkspaceStore.getState().views[id]).toMatchObject({
      tabs: [],
      hiddenSessions: new Set([chat.tabId]),
    });
    expect(call.mock.calls.map(([, method]) => method)).not.toContain("peerChatClose");
    expect(call.mock.calls.map(([, method]) => method)).not.toContain("peerTerminalClose");
  } finally {
    call.mockRestore();
    composer.mockRestore();
    chatRead.mockRestore();
    lists.mockRestore();
    readRoom.mockRestore();
    snapshots.mockRestore();
    usePeerWorkspaceStore.setState(previous, true);
  }
});

test("new-chat and fork replies from a previous peer cannot open tabs after a peer switch", async () => {
  const store = usePeerWorkspaceStore.getState();
  const original = listedRemoteTarget(peer, target.workspace, {
    ...shell,
    kind: "claude",
    tabId: "chat",
  });
  const open = Promise.withResolvers<ReturnType<typeof ipcOk<{ tabId: string }>>>();
  const fork = Promise.withResolvers<ReturnType<typeof ipcOk<{ tabId: string }>>>();
  const call = spyOn(ipc, "ipcCallResult")
    .mockImplementationOnce(() => open.promise)
    .mockImplementationOnce(() => fork.promise);
  const newPeer = { ...target, deviceId: "different" };
  const place = (session: typeof original) => showPeerWorkspaceSession(target, session);
  try {
    store.select(target, null);
    const opening = newPeerChat(original, "claude", undefined, place);
    const forking = forkPeerChat(original, undefined, undefined, place);
    store.select(newPeer, null);
    open.resolve(ipcOk({ tabId: "late-chat" }));
    fork.resolve(ipcOk({ tabId: "late-fork" }));
    await Promise.all([opening, forking]);
    expect(usePeerWorkspaceStore.getState().active).toEqual(newPeer);
    expect(usePeerWorkspaceStore.getState().views).toEqual({});
    expect(call.mock.calls.map(([, method]) => method)).toEqual(["peerChatNew", "peerChatFork"]);
  } finally {
    call.mockRestore();
    usePeerWorkspaceStore.setState(store, true);
  }
});

test("the agents list distinguishes an unread list from a complete empty list", () => {
  const previous = usePeerWorkspaceStore.getState();
  const storeView = spyOn(workspaceStore, "usePeerWorkspaceStore");
  storeView.mockImplementation(
    Object.assign(
      <T,>(select: (state: typeof previous) => T) => select(usePeerWorkspaceStore.getState()),
      usePeerWorkspaceStore,
    ),
  );
  Object.assign(storeView, usePeerWorkspaceStore);
  try {
    previous.select(target, null);
    expect(renderToStaticMarkup(<PeerSessionsPanel target={target} peer={peer} />)).toContain(
      "Loading…",
    );
    expect(renderToStaticMarkup(<PeerSessionsPanel target={target} />)).toContain(
      "Desktop is offline",
    );
    previous.syncSessions(target, [], false);
    expect(renderToStaticMarkup(<PeerSessionsPanel target={target} peer={peer} />)).toContain(
      "No conversations",
    );
  } finally {
    storeView.mockRestore();
    usePeerWorkspaceStore.setState(previous, true);
  }
});
