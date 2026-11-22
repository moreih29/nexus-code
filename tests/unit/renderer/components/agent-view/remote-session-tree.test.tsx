import { expect, mock, spyOn, test } from "bun:test";
import i18next from "i18next";
import type { KeyboardEvent, MouseEvent } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import type { RemoteSession } from "../../../../../packages/remote-protocol/src/rpc";
import { SessionRelations } from "../../../../../src/renderer/components/agent-list/session-tree-rows";
import {
  fromSearch,
  StatusGroups,
  stepRows,
} from "../../../../../src/renderer/components/agent-view/agent-sidebar";
import {
  PeerGroup,
  RemoteSessions,
  workspaceGroups,
} from "../../../../../src/renderer/components/agent-view/remote-sessions";
import * as buttons from "../../../../../src/renderer/components/ui/button";
import * as iconButtons from "../../../../../src/renderer/components/ui/icon-button";
import * as ipc from "../../../../../src/renderer/ipc/client";
import { treeSessions } from "../../../../../src/renderer/services/agent-sessions/session-tree";
import {
  activeKey,
  emptyLayout,
  remoteSessionKey,
} from "../../../../../src/renderer/services/agent-view/layout";
import { RemoteResults } from "../../../../../src/renderer/services/agent-view/remote-results";
import { remoteSessionTree } from "../../../../../src/renderer/services/agent-view/remote-session-tree";
import * as account from "../../../../../src/renderer/services/remote/account";
import { remoteDisplayName } from "../../../../../src/renderer/services/remote/display-name";
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
    expect(html).toContain("↳ <bdi>This computer</bdi> · <bdi>Current local plan</bdi>");
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
  const render = (online: boolean, connected = true) =>
    renderToStaticMarkup(
      <PeerGroup
        peer={host}
        sessions={{ status: "ready", list: { workspaces: [workspace], sessions: [parent, child] } }}
        query=""
        navigation={{ connected, peers: new Map([[source.id, { ...source, online }]]) }}
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
    const label = "↳ <bdi>Studio&lt;em&gt;</bdi> · <bdi>&lt;img&gt;Parent</bdi>";
    for (const inactive of [render(false), render(true, false)]) {
      expect(inactive).toContain(`data-testid="remote-session-parent">${label}</span>`);
    }
    const html = render(true);
    expect(html).toContain(label);
    expect(html).toContain("&lt;a&gt;Re\u200Cview&lt;/a&gt;");
    expect(html).not.toMatch(/[\u202E\u2067\u200B]/u);
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

function remoteWithOpener(opener: NonNullable<RemoteSession["openedBy"]>, selfId?: string) {
  return renderToStaticMarkup(
    <PeerGroup
      peer={host}
      sessions={{
        status: "ready",
        list: { workspaces: [workspace], sessions: [row("child", { openedBy: opener })] },
      }}
      query=""
      navigation={{ selfId, connected: true, peers: new Map() }}
    />,
  );
}

test.each([
  ["en", "Closed conversation"],
  ["ko", "닫힌 대화"],
])("remote trees dim the unnamed closed parent in %s", async (language, label) => {
  const missingId = "1a2b3c4d-missing";
  const child = row("child", {
    openedBy: { workspaceId: workspace.id, tabId: missingId, kind: "tab", agent: "codex" },
  });
  const list = { workspaces: [workspace], sessions: [child] };
  const i18n = i18next.cloneInstance({ lng: language });
  await i18n.changeLanguage(language);
  for (const view of [
    <PeerGroup key="workspace" peer={host} sessions={{ status: "ready", list }} query="" />,
    <StatusGroups
      key="status"
      agents={emptyAgents}
      activity={new Map()}
      remote={[{ peer: host, list }]}
      query=""
      results={new RemoteResults()}
    />,
  ]) {
    const html = renderToStaticMarkup(<I18nextProvider i18n={i18n}>{view}</I18nextProvider>);
    expect(html).toContain(`data-testid="remote-session-parent">↳ ${label}</span>`);
    expect(html).toMatch(/opacity-70"[^>]*data-testid="remote-session-parent"/);
    expect(html).not.toContain(missingId.slice(0, 8));
  }
  expect(remoteSessionTree(host.id, [child], label).roots).toEqual([]);
});

test("a missing remote parent keeps its saved name, terminal agent or device reference", () => {
  const opener = { workspaceId: workspace.id, tabId: "1a2b3c4d-missing" };
  expect(remoteWithOpener({ ...opener, name: "Saved title" })).toContain(
    'data-testid="remote-session-parent">↳ Saved title · closed</span>',
  );
  expect(remoteWithOpener({ ...opener, kind: "terminal", agent: "codex" })).toContain(
    'data-testid="remote-session-parent">↳ codex · closed</span>',
  );
  expect(remoteWithOpener({ ...opener, device: { id: "studio", name: "Studio" } })).toContain(
    'data-testid="remote-session-parent">↳ <bdi>Studio</bdi> · <bdi>1a2b3c4d</bdi></span>',
  );
});

test.each([
  [workspace.id, "constructor"],
  [workspace.id, "toString"],
  [workspace.id, "hasOwnProperty"],
  [workspace.id, "__proto__"],
  ["__proto__", "constructor"],
])("a parent lookup treats workspace %s and tab %s as IDs", (workspaceId, tabId) => {
  const state = tabs.useTabsStore.getInitialState();
  const read = spyOn(tabs, "useTabsStore").mockImplementation((select) =>
    select({ ...state, byWorkspace: { [workspace.id]: {} } }),
  );
  try {
    const opener = {
      workspaceId,
      tabId,
      name: "Saved title",
      device: { id: "self", name: "Stored device" },
    };
    const html = remoteWithOpener(opener, "self");
    expect(html).toContain(
      'data-testid="remote-session-parent">↳ <bdi>This computer</bdi> · <bdi>Saved title</bdi> · closed</span>',
    );
  } finally {
    read.mockRestore();
  }
});

test("a closed local opener is dimmed and an unknown account device keeps the original device label", () => {
  const opener = {
    workspaceId: workspace.id,
    tabId: "closed-tab",
    name: "Saved",
    device: { id: "self", name: "Stored device" },
  };
  const closed = remoteWithOpener(opener, "self");
  expect(closed).toContain(
    'data-testid="remote-session-parent">↳ <bdi>This computer</bdi> · <bdi>Saved</bdi> · closed</span>',
  );
  expect(closed).toContain("opacity-70");
  const unknown = remoteWithOpener(opener);
  expect(unknown).toContain(
    'data-testid="remote-session-parent">↳ <bdi>Stored device</bdi> · <bdi>Saved</bdi></span>',
  );
});

test("local workspace rows keep a saved parent closed when the ID has no own tab record", () => {
  const state = tabs.useTabsStore.getInitialState();
  const read = spyOn(tabs, "useTabsStore").mockImplementation((select) =>
    select({
      ...state,
      // Reject both inherited keys and an own value that is missing tab metadata.
      byWorkspace: {
        [workspace.id]: { bogus: { id: "bogus", title: "Invalid" } },
      } as typeof state.byWorkspace,
    }),
  );
  try {
    const base = remoteSessionTree(host.id, [row("child")], "").roots[0]!;
    for (const tabId of ["constructor", "bogus"]) {
      const node = {
        ...base,
        parentClosed: true as const,
        parentName: "Saved",
        session: {
          ...base.session,
          parent: { kind: "tab" as const, workspaceId: workspace.id, tabId },
        },
      };
      const html = renderToStaticMarkup(<SessionRelations node={node} collapsed={false} />);
      expect(html).toContain("↳ Saved · closed");
      expect(html).toContain("opacity-70");
    }
  } finally {
    read.mockRestore();
  }
});

test("remote labels preserve shaping characters and replace separators with spaces", () => {
  const family = "👨‍👩‍👧";
  const flag = "🏴\u{E0067}\u{E0062}\u{E007F}";
  const shaped = "می‌خواهم";
  const controls = "\u202A\u202B\u202C\u202D\u202E\u2066\u2067\u2068\u2069\u200E\u200F\u061C\u200B";
  expect(
    remoteDisplayName(`${family}\n${flag}\r\n${shaped}\rA\u0085B\u2028C\u2029D${controls}`),
  ).toBe(`${family} ${flag} ${shaped} A B C D`);
  expect(remoteDisplayName(undefined)).toBe("");
  expect(remoteDisplayName({ name: "nested" })).toBe("");
  const bidi = remoteWithOpener({
    workspaceId: workspace.id,
    tabId: "other",
    name: "جلسة",
    device: { id: "away", name: "حاسوب" },
  });
  expect(bidi).toContain("↳ <bdi>حاسوب</bdi> · <bdi>جلسة</bdi>");
});

test("ambiguous remote IDs show a parent name without claiming closure, and cycles stay flat", () => {
  const ref = (tabId: string, name?: string) => ({ workspaceId: workspace.id, tabId, name });
  const rows = [
    row("duplicate"),
    row("duplicate", { workspaceId: task.id }),
    row("ambiguous", { openedBy: ref("duplicate", "Saved ambiguous parent") }),
    row("loop-a", { openedBy: ref("loop-b") }),
    row("loop-b", { openedBy: ref("loop-a") }),
    row("self-loop", { openedBy: ref("self-loop") }),
  ];
  const { roots } = remoteSessionTree(host.id, rows, "");
  expect(roots).toHaveLength(rows.length);
  expect([...treeSessions(roots)].map((session) => session.title)).toEqual(
    rows.map((row) => row.title),
  );
  const html = renderToStaticMarkup(
    <PeerGroup
      peer={host}
      query=""
      sessions={{ status: "ready", list: { workspaces: [workspace, task], sessions: rows } }}
    />,
  );
  expect(html).toContain(">↳ Saved ambiguous parent</span>");
  expect(html).not.toContain("Saved ambiguous parent · closed");
});

test("a listed parent kept out of the tree still provides its current title", () => {
  const shell = row("shell", { kind: "terminal", title: "Current terminal title" });
  const child = row("child", { openedBy: { workspaceId: workspace.id, tabId: shell.tabId } });
  const html = renderToStaticMarkup(
    <PeerGroup
      peer={host}
      query=""
      sessions={{ status: "ready", list: { workspaces: [workspace], sessions: [shell, child] } }}
    />,
  );
  expect(html).toContain(">↳ Current terminal title</span>");
  expect(html).not.toContain("Current terminal title · closed");
});

test("cross-workspace children use the workspace name for a standalone workspace even when it has a Git branch", () => {
  const other = { ...task, parentId: undefined };
  const list = { workspaces: [workspace, other], sessions: [parent, activeChild] };
  for (const html of [
    renderToStaticMarkup(<PeerGroup peer={host} query="" sessions={{ status: "ready", list }} />),
    renderToStaticMarkup(
      <StatusGroups
        agents={emptyAgents}
        activity={new Map()}
        remote={[{ peer: host, list }]}
        query=""
        results={new RemoteResults()}
      />,
    ),
  ]) {
    expect(html).toContain('title="Defaults"');
    expect(html).not.toContain('title="ship"');
  }
});

test("a folded remote workspace counts quiet families including their children", () => {
  const quiet = { ...parent, state: "idle" as const };
  const { groups, hiddenCounts } = workspaceGroups(
    { workspaces: [workspace], sessions: [quiet, idleChild] },
    {
      deviceId: host.id,
      query: "",
      opens: false,
      inPanel: () => false,
      worktreesIn: new Set(),
      folds: new Set([workspace.id]),
    },
  );
  expect(groups).toEqual([[workspace.id, []]]);
  expect(hiddenCounts.get(workspace.id)).toBe(2);
});

test("mark all read includes new results in a folded remote family", () => {
  const quiet = { ...parent, state: "idle" as const };
  const done = { ...activeChild, state: "new-result" as const };
  const resultFeed = new RemoteResults();
  const buttons = spyOn(iconButtons, "IconButton");
  const state = view.useAgentViewStore.getInitialState();
  const fold = `family:${remoteSessionKey({ deviceId: host.id, ...parent })}`;
  const store = spyOn(view, "useAgentViewStore").mockImplementation((select) =>
    select({ ...state, folded: new Set([fold]) }),
  );
  try {
    const html = renderToStaticMarkup(
      <StatusGroups
        agents={emptyAgents}
        activity={new Map()}
        remote={[{ peer: host, list: { workspaces: [workspace, task], sessions: [quiet, done] } }]}
        query=""
        results={resultFeed}
      />,
    );
    expect(html).not.toContain(done.title);
    const props = buttons.mock.calls.find(
      ([props]) =>
        (props as { "data-testid"?: string })["data-testid"] === "agent-sidebar-mark-read",
    )?.[0];
    if (!props?.onClick) throw new Error("missing mark-all button");
    props.onClick({} as MouseEvent<HTMLButtonElement>);
    expect(resultFeed.session(host.id, done, true, false).state).toBe("idle");
  } finally {
    store.mockRestore();
    buttons.mockRestore();
  }
});

test("visible remote rows take arrow and edge keys, and Enter opens the first search result", () => {
  const list = { workspaces: [workspace, task], sessions: [parent, activeChild] };
  const html = renderToStaticMarkup(
    <StatusGroups
      agents={emptyAgents}
      activity={new Map()}
      remote={[{ peer: host, list }]}
      query="release"
      results={new RemoteResults()}
    />,
  );
  const rows = Array.from(
    html.matchAll(/<button[^>]*data-agent-row=""[^>]*title="([^"]+)"/g),
    ([, title]) => ({
      title,
      matches: (selector: string) => selector === "[data-agent-row]",
      focus: mock(() => {}),
      click: mock(() => {}),
    }),
  );
  expect(rows.map((row) => row.title)).toEqual([parent.title, activeChild.title]);
  const listNode = {
    querySelectorAll: (selector: string) => rows.filter((row) => row.matches(selector)),
    querySelector: (selector: string) => rows.find((row) => row.matches(selector)),
  };
  const keydown = (key: string, index: number) =>
    stepRows(
      {
        key,
        target: rows[index],
        currentTarget: listNode,
        preventDefault() {},
      } as unknown as KeyboardEvent<HTMLDivElement>,
      null,
    );
  keydown("ArrowDown", 0);
  keydown("End", 0);
  keydown("ArrowUp", 1);
  keydown("Home", 1);
  expect(rows[0]?.focus).toHaveBeenCalledTimes(2);
  expect(rows[1]?.focus).toHaveBeenCalledTimes(2);
  fromSearch(
    {
      key: "Enter",
      currentTarget: { value: "release" },
      preventDefault() {},
    } as unknown as KeyboardEvent<HTMLInputElement>,
    listNode as unknown as HTMLElement,
  );
  expect(rows[0]?.click).toHaveBeenCalledTimes(1);
  expect(rows[1]?.click).not.toHaveBeenCalled();
});
