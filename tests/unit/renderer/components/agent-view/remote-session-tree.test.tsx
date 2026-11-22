import { expect, spyOn, test } from "bun:test";
import type { MouseEvent } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { RemoteSession } from "../../../../../packages/remote-protocol/src/rpc";
import { StatusGroups } from "../../../../../src/renderer/components/agent-view/agent-sidebar";
import {
  PeerGroup,
  RemoteSessions,
} from "../../../../../src/renderer/components/agent-view/remote-sessions";
import * as buttons from "../../../../../src/renderer/components/ui/button";
import * as ipc from "../../../../../src/renderer/ipc/client";
import {
  activeKey,
  emptyLayout,
  remoteSessionKey,
} from "../../../../../src/renderer/services/agent-view/layout";
import { RemoteResults } from "../../../../../src/renderer/services/agent-view/remote-results";
import * as account from "../../../../../src/renderer/services/remote/account";
import * as room from "../../../../../src/renderer/services/remote/room";
import * as view from "../../../../../src/renderer/state/stores/agent-view";
import { useMountedWorkspacesStore } from "../../../../../src/renderer/state/stores/mounted-workspaces";
import { useRemoteViewStore } from "../../../../../src/renderer/state/stores/remote-view";
import * as tabs from "../../../../../src/renderer/state/stores/tabs";
import type { RoomPeer } from "../../../../../src/shared/remote/room";

const host: RoomPeer = {
  id: "host",
  name: "Re\u200Bmote host",
  online: true,
  platform: "darwin",
  serves: ["sessions"],
};
const workspace = { id: "home", name: "Home", path: "/repo" };
const task = {
  id: "worktree",
  name: "Defaults",
  path: "/repo-task",
  parentId: workspace.id,
  git: { branch: "ship", ahead: 0, behind: 0, uncommitted: 0 },
};
function row(tabId: string, fields: Partial<RemoteSession> = {}): RemoteSession {
  return {
    workspaceId: workspace.id,
    tabId,
    kind: "codex",
    state: "idle",
    title: tabId,
    ...fields,
  };
}

const parent = row("parent", { title: "Plan the release", state: "running", since: 30 });
const openedBy = { workspaceId: "old-home", tabId: parent.tabId, name: "Saved name" };
const activeChild = row("child", {
  workspaceId: task.id,
  title: "Review the release",
  state: "needs-you",
  since: 10,
  openedBy,
});
const idleChild = row("idle", { title: "Read the docs", openedBy });
const treeList = { workspaces: [workspace, task], sessions: [parent, activeChild, idleChild] };
const emptyAgents = { families: [], byKey: new Map() };

test("each computer's family shares the status of its most urgent descendant", () => {
  const other = { ...host, id: "other", name: "Studio" };
  const remote = [
    { peer: host, list: treeList },
    // The same IDs on another machine cannot join this computer's family.
    { peer: other, list: { workspaces: [workspace], sessions: [activeChild] } },
  ];
  const render = (query = "") =>
    renderToStaticMarkup(
      <StatusGroups
        agents={emptyAgents}
        activity={new Map()}
        remote={remote}
        query={query}
        results={new RemoteResults()}
      />,
    );
  const attention = render().split("</section>")[0];
  expect(attention).toContain('class="tabular-nums">2</span>');
  expect(attention).toContain("Plan the release");
  expect(attention).toContain("Review the release");
  expect(attention).toContain("1 idle");
  expect(attention).not.toContain("Read the docs");
  expect(attention?.match(/data-testid="remote-session-fold-family"/g)).toHaveLength(1);
  const search = render("read the docs");
  expect(search).toContain("Plan the release");
  expect(search).toContain("Read the docs");
  expect(search).not.toContain("Review the release");
});

test("worktree children appear once under their opener and only their host's saved fold hides them", () => {
  const render = (peer = host) =>
    renderToStaticMarkup(
      <PeerGroup peer={peer} sessions={{ status: "ready", list: treeList }} query="" />,
    );
  const html = render();
  expect(html).toContain("↳ 1 under Plan the release");
  expect(html).toContain('title="ship"');
  expect(html.match(/>Review the release<\/span>/g)).toHaveLength(1);
  expect(html).toContain("Read the docs");
  const fold = `family:${remoteSessionKey({ deviceId: host.id, ...parent })}`;
  const state = view.useAgentViewStore.getInitialState();
  const store = spyOn(view, "useAgentViewStore").mockImplementation((select) =>
    select({ ...state, folded: new Set([fold]) }),
  );
  try {
    const folded = render();
    expect(folded).not.toContain("Review the release");
    expect(folded).toContain('data-testid="remote-session-summary"');
    expect(render({ ...host, id: "other" })).toContain("Review the release");
  } finally {
    store.mockRestore();
  }
});

test("a local opener uses the account device ID, current title and actual workspace", () => {
  const { useTabsStore } = tabs;
  const { useAgentViewStore } = view;
  const tabsBefore = useTabsStore.getState().byWorkspace;
  const viewBefore = useAgentViewStore.getState();
  const mounted = useMountedWorkspacesStore.getState();
  const local = useTabsStore
    .getState()
    .createTab("actual-home", { type: "claude", props: { cwd: "/local" } });
  useTabsStore.getState().renameTab("actual-home", local.id, "Current local plan");
  useAgentViewStore.setState({ mode: "agents", ...emptyLayout() });
  const readTabs = useTabsStore.getState;
  const read = spyOn(tabs, "useTabsStore").mockImplementation((select) => select(readTabs()));
  const localDevice = { id: "self", name: "Stored name" };
  const localChild = row("launched-there", {
    openedBy: {
      workspaceId: "former-home",
      tabId: local.id,
      name: "Earlier title",
      device: localDevice,
    },
  });
  const signIn = spyOn(account, "useRemoteAccount").mockReturnValue({
    status: "signed-in",
    server: "https://example.invalid",
    device: { ...localDevice, platform: "darwin" },
    user: { id: "owner", name: "Owner", email: "owner@example.invalid" },
  });
  const connection = spyOn(room, "useRemoteRoom").mockReturnValue({
    status: "online",
    peers: [host],
  });
  const lists = spyOn(room, "usePeerSessions").mockReturnValue({
    [host.id]: { status: "ready", list: { workspaces: [workspace], sessions: [localChild] } },
  });
  const renderButton = spyOn(buttons, "Button");
  try {
    const html = renderToStaticMarkup(<RemoteSessions query="" />);
    expect(html).toContain("↳ This computer · Current local plan");
    const click = renderButton.mock.calls.find(([props]) =>
      props.title?.includes("Current local plan"),
    )?.[0].onClick;
    if (!click) throw new Error("Local parent navigation is missing");
    click({} as MouseEvent<HTMLButtonElement>);
    expect(activeKey(useAgentViewStore.getState())).toBe(`actual-home:${local.id}`);
  } finally {
    renderButton.mockRestore();
    lists.mockRestore();
    connection.mockRestore();
    signIn.mockRestore();
    read.mockRestore();
    useTabsStore.setState({ byWorkspace: tabsBefore });
    useAgentViewStore.setState(viewBefore);
    useMountedWorkspacesStore.setState(mounted);
  }
});

test("an external opener's label is plain text and opens only while its device is online", async () => {
  const source = { ...host, id: "source", name: "Studio\u202E<em>", online: true };
  const child = row("child-here", {
    title: "<a>Re\u200Cview</a>",
    openedBy: {
      workspaceId: "source-old-workspace",
      tabId: parent.tabId,
      kind: "tab",
      agent: "codex",
      device: { id: source.id, name: "Saved device" },
      name: "<img>Pa\u2067rent",
    },
  });
  const render = (online: boolean) =>
    renderToStaticMarkup(
      <PeerGroup
        peer={host}
        sessions={{ status: "ready", list: { workspaces: [workspace], sessions: [parent, child] } }}
        query=""
        navigation={{ connected: true, peers: new Map([[source.id, { ...source, online }]]) }}
      />,
    );
  const viewBefore = view.useAgentViewStore.getState();
  const targets = useRemoteViewStore.getState().targets;
  const renderButton = spyOn(buttons, "Button");
  const current = { ...parent, workspaceId: task.id, title: "New\u202D name" };
  const list = spyOn(ipc, "ipcCallResult").mockResolvedValue({
    ok: true,
    value: { workspaces: [task], sessions: [current] },
  });
  try {
    const offline = render(false);
    expect(offline).toContain(
      'data-testid="remote-session-parent">↳ Studio&lt;em&gt; · &lt;img&gt;Parent</span>',
    );
    const html = render(true);
    expect(html).toContain("↳ Studio&lt;em&gt; · &lt;img&gt;Parent");
    expect(html).toContain("&lt;a&gt;Review&lt;/a&gt;");
    expect(html).not.toMatch(/[\p{Cf}]/u);
    expect(html).not.toContain('data-testid="remote-session-fold-family"');
    const click = renderButton.mock.calls.find(([props]) =>
      props.title?.includes("Studio<em>"),
    )?.[0].onClick;
    if (!click) throw new Error("Peer parent navigation is missing");
    click({} as MouseEvent<HTMLButtonElement>);
    await Promise.resolve();
    expect(list).toHaveBeenCalledWith("remote", "peerSessions", { deviceId: source.id });
    const key = remoteSessionKey({ deviceId: source.id, ...current });
    expect(useRemoteViewStore.getState().targets.get(key)).toMatchObject({
      title: "New name",
      deviceName: "Studio<em>",
    });
    expect(activeKey(view.useAgentViewStore.getState())).toBe(key);
  } finally {
    list.mockRestore();
    renderButton.mockRestore();
    view.useAgentViewStore.setState(viewBefore);
    useRemoteViewStore.setState({ targets });
  }
});
