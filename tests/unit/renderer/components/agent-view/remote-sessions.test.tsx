import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import i18next from "i18next";
import type { ComponentProps, DragEvent, MouseEvent, ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import type { RemoteSession } from "../../../../../packages/remote-protocol/src/rpc";
import {
  StatusGroups,
  WorkspaceGroups,
} from "../../../../../src/renderer/components/agent-view/agent-sidebar";
import {
  type PeerReorder,
  peerOrderMenu,
  RemotePeerHeader,
} from "../../../../../src/renderer/components/agent-view/remote-peer-header";
import * as sessionActions from "../../../../../src/renderer/components/agent-view/remote-session-actions";
import * as sessionDrop from "../../../../../src/renderer/components/agent-view/session-drop";
import * as banner from "../../../../../src/renderer/components/ui/banner";
import * as button from "../../../../../src/renderer/components/ui/button";
import type { AgentSession } from "../../../../../src/renderer/services/agent-sessions/model";
import { NO_FACTS } from "../../../../../src/renderer/services/agent-sessions/rows";
import * as rowFacts from "../../../../../src/renderer/services/agent-sessions/use-row-facts";
import { RemoteResults } from "../../../../../src/renderer/services/agent-view/remote-results";
import * as account from "../../../../../src/renderer/services/remote/account";
import * as room from "../../../../../src/renderer/services/remote/room";
import * as agentView from "../../../../../src/renderer/state/stores/agent-view";
import { useNotificationsStore } from "../../../../../src/renderer/state/stores/notifications";
import { useSettingsUIStore } from "../../../../../src/renderer/state/stores/settings-ui";
import type { RoomPeer } from "../../../../../src/shared/remote/room";
import type { WorkspaceMeta } from "../../../../../src/shared/types/workspace";

const {
  HungTerminals,
  OfflinePeer,
  PeerGroup,
  RemoteSessionRow,
  RemoteSessions,
  RemoteTabLabel,
  agentRunsOf,
  listedByDefault,
  listedSessions,
  remoteSessionMenu,
  statusGroups,
  workspaceGroups,
} = await import("../../../../../src/renderer/components/agent-view/remote-sessions");
const { offlinePeers, peerServes, servingPeers } = room;

describe("Other computers connection guidance", () => {
  const server = "https://nexus.example";
  const signedIn = {
    status: "signed-in" as const,
    server,
    user: { id: "u1", email: "me@example.com", name: "Me" },
    device: { id: "d1", name: "Mac", platform: "darwin" },
  };
  let readAccount: ReturnType<typeof spyOn<typeof account, "useRemoteAccount">>;
  let readRoom: ReturnType<typeof spyOn<typeof room, "useRemoteRoom">>;

  beforeEach(() => {
    readAccount = spyOn(account, "useRemoteAccount").mockReturnValue({
      status: "signed-out",
      server,
    });
    readRoom = spyOn(room, "useRemoteRoom").mockReturnValue({ status: "off", peers: [] });
  });

  afterEach(() => {
    readAccount.mockRestore();
    readRoom.mockRestore();
    useSettingsUIStore.getState().closeSettings();
  });

  test("status grouping keeps connection guidance during search and omits computer headings online", () => {
    const renderStatus = (sources: readonly unknown[]) => <div>Sources {sources.length}</div>;
    const render = () =>
      renderToStaticMarkup(<RemoteSessions query="review" renderStatus={renderStatus} />);
    expect(render()).toContain("Sign in to see your other computers here");
    readAccount.mockReturnValue(signedIn);
    readRoom.mockReturnValue({ status: "waiting", peers: [] });
    expect(render()).toContain("Reconnecting");
    readRoom.mockReturnValue({ status: "online", peers: [peer] });
    const readLists = spyOn(room, "usePeerSessions").mockReturnValue({
      [peer.id]: { status: "ready", list: list([session({ title: "Review" })]) },
    });
    try {
      expect(render()).toBe("<div>Sources 1</div>");
    } finally {
      readLists.mockRestore();
    }
  });

  test("shows a signed-out account where to sign in", () => {
    const renderButton = spyOn(button, "Button");
    try {
      const html = renderToStaticMarkup(<RemoteSessions query="" />);
      expect(html).toContain("Other computers");
      expect(html).toContain("Sign in to see your other computers here");
      expect(html).toContain('data-variant="link"');
      expect(html).toContain(">Sign in<");
      const link = renderButton.mock.calls.find(([props]) => props.variant === "link")?.[0];
      link?.onClick?.({} as MouseEvent<HTMLButtonElement>);
      expect(useSettingsUIStore.getState()).toMatchObject({
        settingsOpen: true,
        initialActiveId: "remote",
      });
    } finally {
      renderButton.mockRestore();
    }
  });

  test("hides the signed-out section during search", () => {
    expect(renderToStaticMarkup(<RemoteSessions query="some session" />)).toBe("");
  });

  test.each([
    ["sign-in", "off"],
    ["update", "outdated"],
  ] as const)("closes the %s notice when its dismiss button is pressed", (_, status) => {
    if (status === "outdated") readAccount.mockReturnValue(signedIn);
    readRoom.mockReturnValue({ status, peers: [] });
    const { dismissedBanners } = useNotificationsStore.getState();
    const renderDismiss = spyOn(banner, "BannerDismissButton");
    try {
      const render = () => renderToStaticMarkup(<RemoteSessions query="" />);
      expect(render()).toContain('aria-label="Dismiss"');
      renderDismiss.mock.calls[0]?.[0].dismiss.onDismiss();
      expect(render()).toBe("");
    } finally {
      renderDismiss.mockRestore();
      useNotificationsStore.setState({ dismissedBanners });
    }
  });

  test.each([
    ["connecting", "Connecting…"],
    ["waiting", "Disconnected · Reconnecting"],
    ["online", "No connected computers · Open the app on another device"],
  ] as const)("keeps the signed-in section visible when the room is %s", (status, message) => {
    readAccount.mockReturnValue(signedIn);
    readRoom.mockReturnValue({ status, peers: [] });
    const html = renderToStaticMarkup(<RemoteSessions query="" />);
    expect(html).toContain("Other computers");
    expect(html).toContain(message);
    expect(html).not.toContain("No conversations");
  });

  test.each([
    null,
    "off",
    "replaced",
    "stopped",
  ] as const)("hides the signed-in section with no connection attempt when the room is %s", (status) => {
    readAccount.mockReturnValue(signedIn);
    readRoom.mockReturnValue(status === null ? null : { status, peers: [] });
    expect(renderToStaticMarkup(<RemoteSessions query="" />)).toBe("");
  });

  test("shows only the connection guidance before a list has been received", () => {
    readAccount.mockReturnValue(signedIn);
    readRoom.mockReturnValue({ status: "waiting", peers: [{ ...peer, online: false }] });
    const html = renderToStaticMarkup(<RemoteSessions query="" />);
    expect(html).toContain("Disconnected · Reconnecting");
    expect(html).not.toContain("Work PC");
    expect(html).not.toContain("Loading…");
  });

  test.each([
    "connecting",
    "waiting",
  ] as const)("keeps the sidebar undimmed during the relay drop grace period in %s", (status) => {
    readAccount.mockReturnValue(signedIn);
    const raw = { status, peers: [{ ...peer, online: false }] };
    readRoom.mockReturnValue(raw);
    const shown = spyOn(room, "useShownRoom").mockReturnValue({ status: "online", peers: [peer] });
    const readLists = spyOn(room, "usePeerSessions").mockReturnValue({
      d2: { status: "ready", list: list([session({})]) },
    });
    try {
      const html = renderToStaticMarkup(<RemoteSessions query="" />);
      expect(html).toContain("Work PC");
      expect(html).toContain("Fix the build");
      expect(html).not.toContain("Connecting…");
      expect(html).not.toContain("Disconnected");
      expect(html).not.toContain("opacity-60");
      expect(html).not.toContain('inert=""');
      const statusHtml = renderToStaticMarkup(
        <RemoteSessions
          query=""
          renderStatus={(sources) => (
            <div>
              {sources.length} · {sources[0]?.list.sessions[0]?.title}
            </div>
          )}
        />,
      );
      expect(statusHtml).toBe("<div>1 · Fix the build</div>");
      expect(readLists).toHaveBeenCalledWith([], true);
    } finally {
      readLists.mockRestore();
      shown.mockRestore();
    }
  });

  test("status grouping shows one line for an unavailable computer, even during search", () => {
    readAccount.mockReturnValue(signedIn);
    readRoom.mockReturnValue({
      status: "online",
      peers: [peer, { ...peer, id: "d3", name: "Loading computer" }],
    });
    const readLists = spyOn(room, "usePeerSessions").mockReturnValue({
      d2: { status: "unavailable" },
      d3: { status: "loading" },
    });
    try {
      const html = renderToStaticMarkup(
        <RemoteSessions query="review" renderStatus={() => <div>Groups</div>} />,
      );
      expect(html).toContain('role="status"');
      expect(html).toContain("Work PC · No remote response");
      expect(html.indexOf("Groups")).toBeLessThan(html.indexOf("No remote response"));
      expect(html).not.toContain("Loading computer");
      expect(html).not.toContain("remote-peer-header");
    } finally {
      readLists.mockRestore();
    }
  });

  test("search shows only matching computers and hides the section when none match", () => {
    readAccount.mockReturnValue(signedIn);
    readRoom.mockReturnValue({
      status: "online",
      peers: [peer, { ...peer, id: "d3", name: "Laptop" }],
    });
    const readLists = spyOn(room, "usePeerSessions").mockReturnValue({
      d2: { status: "ready", list: list([session({ last: "Review the audit" })]) },
      d3: {
        status: "ready",
        list: list([
          session({ title: "Write docs" }),
          session({ kind: "terminal", state: "ended", title: "Audit from an exited terminal" }),
        ]),
      },
    });
    try {
      const found = renderToStaticMarkup(<RemoteSessions query=" Audit " />);
      expect(found).toContain("Other computers");
      expect(found).toContain("Work PC");
      expect(found).toContain("Review the audit");
      expect(found).not.toContain("Laptop");
      expect(found).not.toContain("No conversation matches");
      expect(renderToStaticMarkup(<RemoteSessions query="exited terminal" />)).toBe("");
    } finally {
      readLists.mockRestore();
    }
  });

  test("search hides the heading and connection guidance with no remote results", () => {
    readAccount.mockReturnValue(signedIn);
    readRoom.mockReturnValue({ status: "waiting", peers: [] });
    expect(renderToStaticMarkup(<RemoteSessions query="audit" />)).toBe("");
    expect(renderToStaticMarkup(<RemoteSessions query="" />)).toContain("Other computers");
  });
});

const peer: RoomPeer = {
  id: "d2",
  name: "Work PC",
  platform: "win32",
  online: true,
  serves: ["sessions"],
};

const session = (over: Partial<RemoteSession>): RemoteSession => ({
  workspaceId: "w1",
  tabId: "t1",
  kind: "claude",
  title: "Fix the build",
  state: "idle",
  ...over,
});

const list = (sessions: RemoteSession[]) => ({
  workspaces: [
    { id: "w1", name: "api", path: "/src/api" },
    { id: "w2", name: "web", path: "/src/web" },
  ],
  sessions,
});

const localSession = (over: Partial<AgentSession>): AgentSession => ({
  key: "local:t1",
  workspaceId: "local",
  tabId: "t1",
  kind: "codex",
  agent: "codex",
  title: "Local review",
  state: "permissionPending",
  phase: "attention",
  estimated: false,
  since: 20,
  message: undefined,
  prompt: undefined,
  ...over,
});

const localWorkspace = (id: string, name: string): WorkspaceMeta => ({
  id,
  name,
  rootPath: `/${id}`,
  location: { kind: "local", rootPath: `/${id}` },
  color: "auto",
  pinned: false,
  tabs: [],
  sortOrder: 0,
  pinnedSortOrder: 0,
});

describe("status grouping across computers", () => {
  const sources = [
    {
      peer,
      list: {
        ...list([
          session({ title: "Remote earlier review", state: "needs-you", since: 10 }),
          session({ title: "Remote later review", state: "needs-you", since: 30 }),
          session({ title: "Remote recent result", state: "new-result", since: 50 }),
          session({ title: "Remote shell", kind: "terminal" }),
          session({ title: "Remote ended", kind: "terminal", agent: "codex", state: "ended" }),
        ]),
        consents: [
          {
            id: "c1",
            at: 0,
            expiresAt: 60_000,
            expiresInMs: 30_000,
            from: { device: { id: "d3", name: "Laptop" }, workspaceId: "x", tabId: "y" },
            workspaceId: "w1",
            change: { kind: "chatInput", body: "Ship it" },
            eachTime: false,
            answerable: true,
          },
        ],
      },
    },
    {
      peer: { ...peer, id: "d4", name: "Studio" },
      list: list([session({ title: "Another result", state: "new-result", since: 35 })]),
    },
  ];
  const local = [
    localSession({}),
    localSession({
      key: "local:t2",
      title: "Local result",
      state: "completed",
      phase: "done",
      since: 40,
    }),
  ];

  test("shows the workspace hint only when there are no local workspaces or remote rows", () => {
    const render = (remote: typeof sources, query = "") =>
      renderToStaticMarkup(
        <StatusGroups
          agents={{ families: [], byKey: new Map() }}
          activity={new Map()}
          query={query}
          remote={remote}
          results={new RemoteResults()}
        />,
      );
    expect(render([])).toContain("No workspaces yet.");
    expect(render(sources)).not.toContain("No workspaces yet.");
    expect(render(sources, "no matching text")).toContain("No conversation matches");
  });

  test("mixes eligible rows by time and filters them across computers", () => {
    const { groups, consents } = statusGroups(local, sources, "", () => true);
    const titles = (group: string) =>
      groups.find((entry) => entry.group === group)?.rows.map((row) => row.session.title);
    expect(titles("attention")).toEqual([
      "Remote earlier review",
      "Local review",
      "Remote later review",
    ]);
    expect(titles("done")).toEqual(["Remote recent result", "Local result", "Another result"]);
    expect(titles("idle")).toEqual([]);
    expect(consents.map(({ consent }) => consent.id)).toEqual(["c1"]);
    const found = statusGroups(local, sources, " later REVIEW ", () => false);
    expect(found.consents).toEqual([]);
    expect(found.groups.flatMap(({ rows }) => rows.map((row) => row.session.title))).toEqual([
      "Remote later review",
    ]);
    expect(
      statusGroups(local, sources, "shell", () => true).groups.every(
        ({ rows }) => rows.length === 0,
      ),
    ).toBe(true);
  });

  test("renders cards first and counts them with local and remote rows", () => {
    const workspace = localWorkspace("local", "Local project");
    const localRow = local[0]!;
    const facts = spyOn(rowFacts, "useRowFacts").mockReturnValue(NO_FACTS);
    try {
      const html = renderToStaticMarkup(
        <StatusGroups
          agents={{
            families: [],
            byKey: new Map([[localRow.key, { workspace, root: workspace, session: localRow }]]),
          }}
          activity={new Map()}
          query=""
          remote={sources}
          results={new RemoteResults()}
        />,
      );
      expect(html).toContain('class="tabular-nums">4</span>');
      expect(html.indexOf('data-testid="remote-consent"')).toBeLessThan(
        html.indexOf("Remote earlier review"),
      );
      expect(html).toContain(">Work PC<");
      expect(html).toContain(">api<");
      expect(html).toContain('data-agent-row=""');
      expect(html).toContain('data-testid="agent-sidebar-mark-read"');
    } finally {
      facts.mockRestore();
    }
  });
});

describe("local workspace grouping", () => {
  test("keeps active and unread rows in folds and opens them for search and reordering", () => {
    const root = localWorkspace("local", "Local project");
    const task = localWorkspace("task", "Review task");
    const local = [
      localSession({ title: "Local failed", state: "error" }),
      localSession({ key: "local:idle", title: "Local idle", state: "idle", phase: "idle" }),
    ];
    const working = localSession({
      key: "task:working",
      title: "Task working",
      workspaceId: "task",
      state: "running",
      phase: "running",
    });
    const taskRows = [
      working,
      localSession({
        key: "task:idle",
        title: "Task idle",
        workspaceId: "task",
        state: "idle",
        phase: "idle",
      }),
    ];
    const family = {
      root,
      worktrees: [
        { workspace: root, isRoot: true, branch: undefined, sessions: local },
        { workspace: task, isRoot: false, branch: "review", sessions: taskRows },
      ],
    };
    const render = (query = "") =>
      renderToStaticMarkup(
        <WorkspaceGroups
          query={query}
          activity={new Map()}
          agents={{ families: [family], byKey: new Map() }}
        />,
      );
    const state = agentView.useAgentViewStore.getInitialState();
    const folded = new Set(["workspace:local"]);
    const view = spyOn(agentView, "useAgentViewStore").mockImplementation((select) =>
      select({ ...state, folded }),
    );
    const facts = spyOn(rowFacts, "useRowFacts").mockReturnValue(NO_FACTS);
    const dragging = spyOn(sessionDrop, "useSessionDrag").mockReturnValue(null);
    try {
      const workingHtml = render();
      expect(workingHtml).toContain('aria-expanded="false"');
      expect(workingHtml).toContain(">2 hidden<");
      expect(workingHtml).toContain("Task working");
      expect(workingHtml).toContain('text-(--state-error-fg)">Failed</span>');
      expect(workingHtml).not.toContain("Local idle");
      expect(workingHtml).not.toContain("Task idle");
      taskRows[0] = { ...working, state: "completed", phase: "done" };
      expect(render()).toContain("Task working");
      taskRows[0] = { ...working, state: "idle", phase: "idle" };
      expect(render()).not.toContain("Task working");
      expect(render()).toContain(">3 hidden<");

      const found = render("Task idle");
      expect(found).toContain('aria-expanded="true"');
      expect(found).toContain("Task idle");
      expect(found).not.toContain("Local idle");
      dragging.mockReturnValue({ key: "task:working", workspaceId: "task" });
      expect(render()).toContain("Local idle");
      expect(render()).toContain("Task idle");
    } finally {
      facts.mockRestore();
      view.mockRestore();
      dragging.mockRestore();
    }
  });
});

const worktreeList = {
  workspaces: [
    { id: "w1", name: "api", path: "/src/api" },
    { id: "running", name: "api-fix", path: "/wt/api-fix", parentId: "w1" },
    { id: "docs", name: "api-docs", path: "/wt/api-docs", parentId: "w1" },
    { id: "w2", name: "web", path: "/src/web" },
    { id: "cache", name: "web-cache", path: "/wt/web-cache", parentId: "w2" },
    { id: "tests", name: "web-tests", path: "/wt/web-tests", parentId: "w2" },
    { id: "waiting", name: "web-review", path: "/wt/web-review", parentId: "w2" },
    { id: "open", name: "web-open", path: "/wt/web-open", parentId: "w2" },
    { id: "empty", name: "web-empty", path: "/wt/web-empty", parentId: "w2" },
    { id: "tools", name: "tools", path: "/src/tools" },
    { id: "orphan", name: "orphan", path: "/wt/orphan", parentId: "missing" },
  ],
  sessions: [
    session({ workspaceId: "w1", kind: "terminal", title: "api shell" }),
    session({ workspaceId: "running", title: "Fix login", state: "running" }),
    session({ workspaceId: "docs", title: "Update API docs" }),
    session({ workspaceId: "docs", tabId: "t2", title: "Check schemas" }),
    session({ workspaceId: "cache", title: "Review cache", last: "Found cache misses" }),
    session({ workspaceId: "tests", kind: "terminal", title: "Run web tests" }),
    session({ workspaceId: "waiting", title: "Approve refactor", state: "needs-you" }),
    session({ workspaceId: "open", kind: "terminal", title: "Open shell" }),
    session({ workspaceId: "tools", title: "Update tools" }),
    session({ workspaceId: "orphan", title: "Fix standalone branch" }),
    session({ workspaceId: "missing", title: "Session without workspace metadata" }),
  ],
};

describe("the agent view's other computers", () => {
  test("folded computers show priority counts and expand for search or computer reordering", () => {
    const state = agentView.useAgentViewStore.getInitialState();
    const foldedGroups = new Set(["peer:d2", "peer-ws:d2:w1"]);
    const view = spyOn(agentView, "useAgentViewStore").mockImplementation((select) =>
      select({ ...state, folded: foldedGroups }),
    );
    const sessions = {
      status: "ready" as const,
      list: list([
        session({ tabId: "active", title: "Working on review", state: "running" }),
        session({ tabId: "ask1", title: "Review confirmation", state: "needs-you" }),
        session({ tabId: "ask2", title: "Another request", state: "needs-you" }),
        session({ tabId: "idle", title: "Idle review" }),
      ]),
    };
    const render = (query = "", reorder?: PeerReorder) =>
      renderToStaticMarkup(
        <PeerGroup peer={peer} query={query} sessions={sessions} reorder={reorder} />,
      );
    try {
      const folded = render();
      expect(folded).toContain('aria-expanded="false"');
      expect(folded).toContain('data-testid="remote-peer-count-attention"');
      expect(folded).toContain('data-testid="remote-peer-count-running"');
      expect(folded).toContain("</span>2</span>");
      expect(folded).toContain("</span>1</span>");
      expect(folded).not.toContain("Working on review");
      expect(render("idle review")).toContain("Idle review");
      expect(render("idle review")).not.toContain(">1 hidden<");
      const dragging = render("", {
        ids: ["d2", "d3"],
        drag: { id: "d3", drop: { target: "d2", edge: "after" } },
        setDrag: () => {},
        move: () => {},
      });
      expect(dragging).toContain("Working on review");
      expect(dragging).toContain("1 hidden");
      expect(dragging).not.toContain("Idle review");
    } finally {
      view.mockRestore();
    }
  });

  test("folded workspaces hide their quiet conversations and shells, including tasks", () => {
    const workspaces = [
      ...list([]).workspaces,
      { id: "task", name: "Task branch", path: "/task", parentId: "w1" },
    ];
    const running = session({
      workspaceId: "task",
      tabId: "active",
      title: "Task active",
      state: "running",
    });
    const sessions = [
      running,
      session({ workspaceId: "task", tabId: "quiet-task", title: "Task idle" }),
      session({ tabId: "ask", title: "Review confirmation", state: "needs-you" }),
      session({ tabId: "quiet", title: "Project idle" }),
      session({ tabId: "plain", title: "Project shell", kind: "terminal" }),
    ];
    const results = new RemoteResults();
    const state = agentView.useAgentViewStore.getInitialState();
    const foldedGroups = new Set(["peer-ws:d2:w1", "peer-ws:d2:task"]);
    const view = spyOn(agentView, "useAgentViewStore").mockImplementation((select) =>
      select({ ...state, folded: foldedGroups }),
    );
    const render = () =>
      renderToStaticMarkup(
        <PeerGroup
          peer={{ ...peer, serves: ["sessions", "sessions.reorder"] }}
          query=""
          results={results}
          sessions={{ status: "ready", list: { workspaces, sessions } }}
        />,
      );
    try {
      const working = render();
      expect(working).toContain("2 hidden");
      expect(working).toContain("Task active");
      expect(working).toContain("Review confirmation");
      expect(working).toContain('draggable="true"');
      for (const text of ["Task idle", "Project idle", "Project shell", "remote-terminals-toggle"])
        expect(working).not.toContain(text);
      const finished = { ...running, state: "new-result" as const, since: 10 };
      sessions[0] = finished;
      expect(render()).toContain("Task active");
      results.markSeen([{ deviceId: peer.id, session: finished }]);
      expect(render()).not.toContain("Task active");
      expect(render()).toContain("3 hidden");

      const expanded = workspaceGroups(
        { workspaces, sessions },
        {
          query: "",
          opens: false,
          inPanel: () => false,
          worktreesIn: new Set(),
          folds: new Set(["w1", "task"]),
          reordering: new Set(["task"]),
        },
      );
      expect(expanded.foldedWorkspaces.size).toBe(0);
      expect(expanded.groups.find(([id]) => id === "task")?.[1].map((row) => row.title)).toEqual([
        "Task active",
        "Task idle",
      ]);
    } finally {
      view.mockRestore();
    }
  });

  test("a Korean row waiting for a reply uses the local attention label", async () => {
    const ko = i18next.cloneInstance({ lng: "ko" });
    await ko.changeLanguage("ko");
    const html = renderToStaticMarkup(
      <I18nextProvider i18n={ko}>
        <RemoteSessionRow session={session({ state: "needs-you" })} />
      </I18nextProvider>,
    );
    expect(html).toContain(`class="sr-only">${ko.t("agentList.group.attention")}</span>`);
  });

  test("orders both groups and only offers reordering with multiple online computers outside search", () => {
    const signedIn = {
      status: "signed-in" as const,
      server: "https://nexus.example",
      user: { id: "u1", email: "me@example.com", name: "Me" },
      device: { id: "d1", name: "Mac", platform: "darwin" },
    };
    const peers = [
      { ...peer, id: "new", name: "New PC" },
      { ...peer, id: "office", name: "Office PC", online: false },
      { ...peer, id: "laptop", name: "Laptop" },
      { ...peer, id: "home", name: "Home PC", online: false },
      { ...peer, id: "desk", name: "Desk PC" },
    ];
    const readRoom = spyOn(room, "useRemoteRoom").mockReturnValue({ status: "online", peers });
    const readAccount = spyOn(account, "useRemoteAccount").mockReturnValue(signedIn);
    const readLists = spyOn(room, "usePeerSessions").mockReturnValue(
      Object.fromEntries(
        peers.map(({ id }) => [
          id,
          { status: "ready", list: list([session({ title: "Example session" })]) },
        ]),
      ),
    );
    const accountKey = JSON.stringify([signedIn.server, signedIn.user.id]);
    const state = agentView.useAgentViewStore.getInitialState();
    const readView = spyOn(agentView, "useAgentViewStore").mockImplementation((select) =>
      select({
        ...state,
        peerOrder: { accountKey, ids: ["office", "laptop", "home", "removed", "desk"] },
        peerOrderAccount: accountKey,
      }),
    );
    const headers = (query = "") => {
      const html = renderToStaticMarkup(<RemoteSessions query={query} />);
      return [
        ...html.matchAll(
          /<(?:button|div)[^>]*data-testid="remote-peer-(?:header|offline)"[^>]*>.*?<\/(?:button|div)>/g,
        ),
      ].map(([header]) => header);
    };
    const expectHeaders = (rows: string[], names: string[], reorderable: number) => {
      expect(rows).toHaveLength(names.length);
      for (const [index, name] of names.entries()) {
        expect(rows[index]).toContain(name);
        expect(rows[index]?.includes('draggable="true"')).toBe(index < reorderable);
        expect(rows[index]?.includes('data-state="closed"')).toBe(index < reorderable);
      }
    };
    try {
      expectHeaders(headers(), ["Laptop", "Desk PC", "New PC", "Office PC", "Home PC"], 3);
      expectHeaders(headers("session"), ["Laptop", "Desk PC", "New PC"], 0);

      readAccount.mockReturnValue({ ...signedIn, user: { ...signedIn.user, id: "u2" } });
      expectHeaders(headers(), ["Desk PC", "Laptop", "New PC", "Home PC", "Office PC"], 0);
      readAccount.mockReturnValue(signedIn);

      readRoom.mockReturnValue({
        status: "online",
        peers: peers.filter(({ id }) => id !== "laptop" && id !== "new"),
      });
      expectHeaders(headers(), ["Desk PC", "Office PC", "Home PC"], 0);
    } finally {
      readView.mockRestore();
      readLists.mockRestore();
      readRoom.mockRestore();
      readAccount.mockRestore();
    }
  });

  test("the menu moves to the adjacent online computer and omits actions at the ends", () => {
    const moves: unknown[] = [];
    const ids = ["laptop", "pc", "mac"];
    const menu = (id: string) =>
      peerOrderMenu(id, { ids, move: (...args) => moves.push(args) }).filter(
        (item) => item.kind === "item",
      );

    expect(menu("pc").map((item) => item.label)).toEqual(["Move up", "Move down"]);
    expect(menu("laptop").map((item) => item.label)).toEqual(["Move down"]);
    expect(menu("mac").map((item) => item.label)).toEqual(["Move up"]);
    expect(menu("offline")).toEqual([]);
    menu("laptop")[0]?.onSelect();
    menu("mac")[0]?.onSelect();
    for (const item of menu("pc")) item.onSelect();
    expect(moves).toEqual([
      ["laptop", "pc", "after"],
      ["mac", "pc", "before"],
      ["pc", "laptop", "before"],
      ["pc", "mac", "after"],
    ]);
  });

  test("lists only the devices in the room that serve their sessions", () => {
    const peers: RoomPeer[] = [
      peer,
      { ...peer, id: "d3", online: false },
      { ...peer, id: "d4", serves: [] },
      { id: "d5", name: "Phone", platform: "ios", online: true },
    ];
    expect(servingPeers({ status: "online", peers }).map((p) => p.id)).toEqual(["d2"]);
    expect(servingPeers({ status: "waiting", peers })).toEqual([]);
    expect(servingPeers(null)).toEqual([]);
  });

  test("keeps the computers out of the room listed, greyed, but not a phone", () => {
    const peers: RoomPeer[] = [
      peer,
      { ...peer, id: "d3", name: "Laptop", platform: "darwin", online: false, serves: undefined },
      { id: "d5", name: "Phone", platform: "ios", online: false },
    ];
    expect(offlinePeers({ status: "online", peers }).map((p) => p.id)).toEqual(["d3"]);
    // This device out of the room knows nothing of who else is.
    expect(offlinePeers({ status: "waiting", peers })).toEqual([]);
    const html = renderToStaticMarkup(<OfflinePeer peer={peers[1]!} />);
    expect(html).toContain("Laptop");
    expect(html).toContain("macOS");
    expect(html).toContain("Offline");
  });

  test("names the computer and its system, and its sessions by workspace", () => {
    const html = renderToStaticMarkup(
      <PeerGroup
        peer={peer}
        query=""
        sessions={{
          status: "ready",
          list: list([
            session({ tabId: "t1", title: "Fix the build", last: "Done." }),
            session({
              tabId: "t2",
              workspaceId: "w2",
              kind: "terminal",
              title: "claude in a terminal",
              agent: "claude",
            }),
            session({ tabId: "t3", workspaceId: "w2", kind: "terminal", title: "dev server" }),
          ]),
        }}
      />,
    );
    expect(html).toContain("Work PC");
    expect(html).toContain("Windows");
    expect(html).toContain("api");
    expect(html).toContain("web");
    expect(html).toContain("Fix the build");
    expect(html).toContain("Done.");
    expect(html).toContain("claude in a terminal");
    // A terminal with only its shell waits behind the toggle.
    expect(html).not.toContain("dev server");
    expect(html).toContain("Show 1 terminal");
  });

  test("lists a session's running agents under its row, as this computer's, with nothing to open", () => {
    const html = renderToStaticMarkup(
      <PeerGroup
        peer={peer}
        query=""
        sessions={{
          status: "ready",
          list: list([
            session({
              tabId: "t1",
              title: "Fix the build",
              state: "running",
              agents: [
                {
                  id: "s1",
                  kind: "subagent",
                  type: "Explore",
                  description: "Find the config loader",
                  state: "running",
                  start: Date.now() - 5_000,
                },
                {
                  id: "p1",
                  kind: "print",
                  program: "codex",
                  state: "permissionPending",
                  start: Date.now() - 1_000,
                },
              ],
            }),
            session({ tabId: "t2", title: "No agents" }),
          ]),
        }}
      />,
    );
    expect(html).toContain("Find the config loader");
    expect(html.match(/data-testid="agent-list-agent-rows"/g)?.length).toBe(1);
    // Shown, not picked: no button among the agents' rows.
    const rows = html.slice(html.indexOf('data-testid="agent-list-agent-rows"'));
    expect(rows.slice(0, rows.indexOf("</ul>"))).not.toContain("<button");
  });

  test("an agent another computer tells is read as this computer's own", () => {
    expect(
      agentRunsOf([{ id: "s1", kind: "subagent", type: "Explore", state: "running", start: 5 }]),
    ).toEqual([
      {
        id: "s1",
        kind: "subagent",
        type: "Explore",
        state: "running",
        start: 5,
        tools: [],
        toolCount: 0,
        failedCount: 0,
      },
    ]);
    expect(agentRunsOf(undefined)).toEqual([]);
  });

  test("shows a terminal unasked only when it runs an agent, also as an older computer lists it", () => {
    const terminal = (over: Partial<RemoteSession>) => session({ kind: "terminal", ...over });
    expect(listedByDefault(session({}))).toBe(true);
    expect(listedByDefault(terminal({}))).toBe(false);
    expect(listedByDefault(terminal({ agent: "codex" }))).toBe(true);
    // Without `agent`: one that waits, works or said something runs one.
    expect(listedByDefault(terminal({ state: "running" }))).toBe(true);
    expect(listedByDefault(terminal({ last: "Done" }))).toBe(true);
    expect(listedByDefault(terminal({ waiting: { kind: "permission", text: "Bash rm" } }))).toBe(
      true,
    );
    // The local agent list also leaves out agents whose terminal ended.
    expect(listedByDefault(terminal({ agent: "claude", state: "ended" }))).toBe(false);
  });

  test("leaves a workspace's terminals with only their shell to its chip, unless in a panel or found", () => {
    const plain = session({ tabId: "t9", kind: "terminal", title: "dev server" });
    const other = session({ tabId: "t8", workspaceId: "w2", kind: "terminal", title: "logs" });
    const chat = session({ tabId: "t1" });
    const none = () => false;
    const all = [chat, plain, other];
    expect(listedSessions(all, "", none)).toEqual({
      listed: [chat],
      plain: new Map([
        ["w1", [plain]],
        ["w2", [other]],
      ]),
    });
    // One in a panel is listed with the others, and its chip no longer counts it.
    expect(listedSessions(all, "", (s) => s.tabId === "t9")).toEqual({
      listed: [chat, plain],
      plain: new Map([["w2", [other]]]),
    });
    expect(listedSessions(all, "server", none)).toEqual({
      listed: [plain],
      plain: new Map(),
    });
  });

  test("ended terminals are excluded from the list, search and shell chip even if held", () => {
    const ended = session({
      kind: "terminal",
      title: "Exited Codex",
      agent: "codex",
      state: "ended",
    });
    const inPanel = () => true;
    expect(listedSessions([ended], "", inPanel)).toEqual({ listed: [], plain: new Map() });
    expect(listedSessions([ended], "Exited", inPanel)).toEqual({
      listed: [],
      plain: new Map(),
    });
    expect(listedSessions([ended], "", () => false)).toEqual({
      listed: [],
      plain: new Map(),
    });
  });

  test("each workspace has its own chip for its terminals in its heading, one with only terminals too", () => {
    const html = renderToStaticMarkup(
      <PeerGroup
        peer={peer}
        query=""
        sessions={{
          status: "ready",
          list: list([
            session({ tabId: "t1", title: "Fix the build" }),
            session({ tabId: "t2", kind: "terminal", title: "dev server" }),
            session({ tabId: "t3", workspaceId: "w2", kind: "terminal", title: "logs" }),
            session({ tabId: "t4", workspaceId: "w2", kind: "terminal", title: "tail" }),
          ]),
        }}
      />,
    );
    expect(html.match(/data-testid="remote-terminals-toggle"/g)?.length).toBe(2);
    expect(html).toContain('data-workspace="w1"');
    expect(html).toContain('data-workspace="w2"');
    expect(html).toContain('aria-label="Show 1 terminal"');
    expect(html).toContain('aria-label="Show 2 terminals"');
    // The workspace with only terminals is named, for its chip.
    expect(html).toContain(">web<");
    expect(html).not.toContain("dev server");
    expect(html).not.toContain(">logs<");
    // Each chip is in its own workspace's heading, before that workspace's rows.
    const headings = html.split('data-testid="remote-workspace"').slice(1);
    expect(headings[0]?.split("</div>")[0]).toContain("Show 1 terminal");
    expect(html.indexOf("Show 1 terminal")).toBeLessThan(html.indexOf("Fix the build"));
    expect(headings[1]?.split("</div>")[0]).toContain("Show 2 terminals");
  });

  test("a workspace's terminals chip reads as a link: a terminal, how many, and which way it goes", () => {
    const html = renderToStaticMarkup(
      <PeerGroup
        peer={peer}
        query=""
        sessions={{
          status: "ready",
          list: list([
            session({ tabId: "t1", title: "Fix the build" }),
            session({ tabId: "t2", kind: "terminal", title: "dev server" }),
          ]),
        }}
      />,
    );
    const chip = html.slice(
      html.lastIndexOf("<button", html.indexOf('data-testid="remote-terminals-toggle"')),
    );
    const end = chip.indexOf("</button>");
    expect(chip.slice(0, end)).toContain("text-(--state-selected-indicator)");
    expect(chip.slice(0, end)).toContain("rounded-full");
    expect(chip.slice(0, end)).toContain('aria-expanded="false"');
    expect(chip.slice(0, end)).toContain("lucide-square-terminal");
    expect(chip.slice(0, end)).toContain(">1<");
    expect(chip.slice(0, end)).toContain("lucide-chevron-down");
  });

  test("terminals asked for hang from the heading's icon: set in, a line down to each", () => {
    const html = renderToStaticMarkup(
      <HungTerminals
        rows={[
          { key: "t1", row: <span>dev server</span> },
          { key: "t2", row: <span>zsh</span> },
        ]}
      />,
    );
    const rows = html.split('class="relative pl-5"').slice(1);
    expect(rows).toHaveLength(2);
    // The first reaches up to the icon; it goes on down and branches off to its row.
    expect(rows[0]).toContain("-top-1");
    expect(rows[0]).toContain("bottom-0");
    expect(rows[0]).toContain("top-1/2");
    expect(rows[0]).toContain("dev server");
    // The last turns to its row and ends there.
    expect(rows[1]).toContain("top-0");
    expect(rows[1]).toContain("bottom-1/2");
    expect(rows[1]).toContain("border-b");
    expect(rows[1]).toContain("zsh");
  });

  test("each read-only workspace discloses only its own quiet worktrees in peer order", () => {
    const grouped = (...expanded: string[]) =>
      workspaceGroups(worktreeList, {
        query: "",
        opens: false,
        inPanel: (s) => s.workspaceId === "open",
        worktreesIn: new Set(expanded),
      });
    const ids = (...expanded: string[]) => grouped(...expanded).groups.map(([id]) => id);
    expect(ids()).toEqual(["w1", "running", "w2", "waiting", "open", "tools", "orphan", "missing"]);
    expect(ids("w2")).toEqual([
      "w1",
      "running",
      "w2",
      "cache",
      "tests",
      "waiting",
      "open",
      "tools",
      "orphan",
      "missing",
    ]);
    expect(ids("w1")).toEqual([
      "w1",
      "running",
      "docs",
      "w2",
      "waiting",
      "open",
      "tools",
      "orphan",
      "missing",
    ]);
    expect([...grouped("w1", "w2").worktreeCounts]).toEqual([
      ["w1", 1],
      ["w2", 2],
    ]);
    expect(grouped("w2").groups.find(([id]) => id === "tests")).toEqual(["tests", []]);
    expect(
      grouped("w2")
        .plain.get("tests")
        ?.map((s) => s.title),
    ).toEqual(["Run web tests"]);
    expect(grouped().plain.has("open")).toBe(false);
  });

  test("a new result or usage limit wait keeps a worktree visible", () => {
    const { groups, worktreeCounts } = workspaceGroups(
      {
        ...worktreeList,
        sessions: [
          session({ workspaceId: "docs", state: "new-result" }),
          session({ workspaceId: "cache", limitWait: { at: 12_000 } }),
        ],
      },
      { query: "", opens: false, inPanel: () => false, worktreesIn: new Set() },
    );
    expect(groups.map(([id]) => id)).toEqual(["w1", "docs", "w2", "cache"]);
    expect(worktreeCounts.size).toBe(0);
  });

  test("a read-only parent with no sessions shows a worktree pill, before the terminal pill when present", () => {
    const html = renderToStaticMarkup(
      <PeerGroup peer={peer} query="" sessions={{ status: "ready", list: worktreeList }} />,
    );
    const headers = html.split('data-testid="remote-workspace"').slice(1);
    const api = headers[0]?.split("</div>")[0];
    const web = headers[2]?.split("</div>")[0];
    expect(api).toContain('aria-label="Show 1 task in api"');
    expect(api).toContain('data-testid="remote-worktrees-toggle" data-workspace="w1"');
    expect(api).toContain('aria-expanded="false"');
    expect(api).toContain("lucide-git-branch");
    expect(api).toContain("lucide-chevron-down");
    expect(api?.indexOf("remote-worktrees-toggle")).toBeLessThan(
      api?.indexOf("remote-terminals-toggle") ?? -1,
    );
    expect(web).toContain('aria-label="Show 3 tasks in web"');
    expect(html.match(/data-testid="remote-worktrees-toggle"/g)).toHaveLength(2);
    expect(html).toContain("Fix login");
    expect(html).toContain("Approve refactor");
    expect(html).toContain("Fix standalone branch");
    expect(html).not.toContain("Review cache");
    expect(html).not.toContain("Update API docs");
    expect(html).not.toContain("api shell");
  });

  test("search finds a collapsed worktree's chat or terminal without creating empty headings", () => {
    const render = (query: string) =>
      renderToStaticMarkup(
        <PeerGroup peer={peer} query={query} sessions={{ status: "ready", list: worktreeList }} />,
      );
    const chat = render("CACHE MISSES");
    expect(chat).toContain("Review cache");
    expect(chat).toContain(">web-cache<");
    expect(chat).not.toContain(">web<");
    expect(chat).not.toContain("data-task");
    expect(chat).not.toContain("remote-worktrees-toggle");
    const terminal = render("web tests");
    expect(terminal).toContain("Run web tests");
    expect(terminal).not.toContain("remote-terminals-toggle");
  });

  test("controls can start sessions in empty worktrees under known parents", () => {
    const empty = {
      workspaces: [
        { id: "w1", name: "api", path: "/src/api" },
        { id: "docs", name: "api-docs", path: "/wt/api-docs", parentId: "w1" },
        { id: "orphan", name: "orphan", path: "/wt/orphan", parentId: "missing" },
      ],
      sessions: [],
    };
    const grouped = (opens: boolean, ...expanded: string[]) =>
      workspaceGroups(empty, {
        query: "",
        opens,
        inPanel: () => false,
        worktreesIn: new Set(expanded),
      });
    expect(grouped(false).groups).toEqual([]);
    expect(grouped(true).groups).toEqual([["w1", []]]);
    expect([...grouped(true).worktreeCounts]).toEqual([["w1", 1]]);
    expect(grouped(true, "w1").groups).toEqual([
      ["w1", []],
      ["docs", []],
    ]);
  });

  test.each([
    ["running", true],
    ["permissionPending", true],
    ["completed", false],
    ["stopped", false],
    ["failed", false],
  ] as const)("a child with a %s subagent stays visible only while the subagent is active", (state, live) => {
    const group = workspaceGroups(
      {
        workspaces: [
          { id: "w1", name: "api", path: "/src/api" },
          { id: "docs", name: "api-docs", path: "/wt/api-docs", parentId: "w1" },
        ],
        sessions: [
          session({
            workspaceId: "docs",
            agents: [{ id: "agent", kind: "subagent", state, start: 0 }],
          }),
        ],
      },
      { query: "", opens: false, inPanel: () => false, worktreesIn: new Set() },
    );
    expect(group.groups.map(([id]) => id)).toEqual(live ? ["w1", "docs"] : ["w1"]);
    expect(group.worktreeCounts.get("w1")).toBe(live ? undefined : 1);
  });

  test("heads a workspace as its group's title: a folder, or a task's branch and how it stands", () => {
    const html = renderToStaticMarkup(
      <PeerGroup
        peer={peer}
        query=""
        sessions={{
          status: "ready",
          list: {
            workspaces: [
              { id: "w1", name: "api", path: "/src/api" },
              {
                id: "w2",
                name: "api-fix",
                path: "/wt/api-fix",
                parentId: "w1",
                git: { branch: "fix/login", ahead: 2, behind: 0, uncommitted: 3 },
              },
            ],
            sessions: [
              session({ tabId: "t1", title: "Fix the build" }),
              session({ tabId: "t2", workspaceId: "w2", title: "Fix login", state: "running" }),
            ],
          },
        }}
      />,
    );
    const headings = html.split('data-testid="remote-workspace"').slice(1);
    expect(headings).toHaveLength(2);
    expect(headings[0]).toContain("lucide-folder");
    expect(headings[0]).toContain("font-semibold");
    expect(headings[1]).toContain("lucide-git-branch");
    expect(headings[1]).toContain("fix/login ↑2 ●");
  });

  test("hangs active worktrees under their known parent, even if it has no sessions", () => {
    const render = (sessions: RemoteSession[], parentKnown = true) =>
      renderToStaticMarkup(
        <PeerGroup
          peer={peer}
          query=""
          sessions={{
            status: "ready",
            list: {
              workspaces: [
                ...(parentKnown ? [{ id: "w1", name: "api", path: "/src/api" }] : []),
                { id: "w2", name: "api-fix", path: "/wt/api-fix", parentId: "w1" },
              ],
              sessions,
            },
          }}
        />,
      );
    // The group's opening tag, before its heading.
    const groups = (html: string) =>
      html
        .split('data-testid="remote-workspace"')
        .slice(0, -1)
        .map((before) => before.slice(before.lastIndexOf('<div class="flex flex-col not-first')));
    const active = session({
      tabId: "t2",
      workspaceId: "w2",
      title: "Fix login",
      state: "running",
    });
    const html = render([active]);
    expect(html).toContain(">api<");
    expect(html).toContain("Fix login");
    expect(html).not.toContain("remote-worktrees-toggle");
    const both = groups(html);
    expect(both).toHaveLength(2);
    expect(both[0]).not.toContain("data-task");
    expect(both[1]).toContain("data-task");
    expect(both[1]).toContain("ml-3.5 border-border border-l");
    const alone = groups(render([active], false));
    expect(alone).toHaveLength(1);
    expect(alone[0]).not.toContain("data-task");
  });

  test("finds sessions by their title or last line", () => {
    const html = renderToStaticMarkup(
      <PeerGroup
        peer={peer}
        query="tests"
        sessions={{
          status: "ready",
          list: list([
            session({ tabId: "t1", title: "Fix the build" }),
            session({ tabId: "t2", workspaceId: "w2", title: "Refactor", last: "All tests pass." }),
          ]),
        }}
      />,
    );
    expect(html).not.toContain("Fix the build");
    expect(html).toContain("Refactor");
    // A workspace with nothing found is not shown.
    expect(html).not.toContain(">api<");
    expect(html).toContain(">web<");
  });

  test("says when it is asking, when the computer does not answer, and when it has nothing", () => {
    const render = (sessions: Parameters<typeof PeerGroup>[0]["sessions"]) =>
      renderToStaticMarkup(<PeerGroup peer={peer} query="" sessions={sessions} />);
    expect(render(undefined)).toContain("Loading…");
    expect(render({ status: "unavailable" })).toContain("No remote response");
    expect(render({ status: "ready", list: list([]) })).toContain("No conversations");
  });

  test("a session waiting on the user says what for", () => {
    const html = renderToStaticMarkup(
      <RemoteSessionRow
        session={session({
          state: "needs-you",
          waiting: { kind: "permission", text: "Run bun test?" },
          last: "Let me run the tests.",
        })}
      />,
    );
    expect(html).toContain("Needs you");
    expect(html).toContain("Run bun test?");
  });

  test("shows a failed turn in red next to its time and accepts an older row without the flag", () => {
    const row = session({ since: Date.now(), state: "idle" });
    const failed = renderToStaticMarkup(<RemoteSessionRow session={{ ...row, failed: true }} />);
    expect(failed).toContain('text-(--state-error-fg)">Failed</span>');
    expect(failed.indexOf(">Failed<")).toBeLessThan(failed.indexOf(">just now<"));
    expect(renderToStaticMarkup(<RemoteSessionRow session={row} />)).not.toContain(">Failed<");
  });

  test("a row is a button that opens the session, marked as this computer's are while a panel has it", () => {
    const shown = renderToStaticMarkup(
      <RemoteSessionRow session={session({})} where="shown" onOpen={() => {}} />,
    );
    expect(shown).toContain('<button type="button" aria-current="true"');
    expect(shown).toContain("bg-[var(--sidebar-item-selected-bg)]");
    expect(shown).toContain('data-testid="remote-session-panel" data-where="shown"');
    expect(shown).toContain('aria-label="Shown in a panel"');

    const held = renderToStaticMarkup(<RemoteSessionRow session={session({})} where="held" />);
    expect(held).not.toContain("aria-current");
    expect(held).not.toContain("bg-[var(--sidebar-item-selected-bg)]");
    expect(held).toContain('data-testid="remote-session-panel" data-where="held"');

    const none = renderToStaticMarkup(<RemoteSessionRow session={session({})} />);
    expect(none).not.toContain("remote-session-panel");
    expect(none).not.toContain("aria-current");
  });

  test("where it lets this one control, each workspace's heading has a +, one with no sessions too", () => {
    const controlled: RoomPeer = { ...peer, serves: ["sessions", "chat.control"] };
    const render = (query: string, of: RoomPeer = controlled) =>
      renderToStaticMarkup(
        <PeerGroup
          peer={of}
          query={query}
          sessions={{
            status: "ready",
            list: {
              workspaces: [
                { id: "w1", name: "api", path: "/src/api" },
                { id: "w2", name: "web", path: "/src/web" },
                { id: "w3", name: "api-fix", path: "/wt/api-fix", parentId: "w1" },
              ],
              sessions: [session({ tabId: "t1", title: "Fix the build" })],
            },
          }}
        />,
      );
    const html = render("");
    const headings = html.split('data-testid="remote-workspace"').slice(1);
    // The workspace with none listed shows for its +, as one of this computer's does; a task does not.
    expect(headings).toHaveLength(2);
    expect(headings[1]).toContain(">web<");
    expect(html).not.toContain("api-fix");
    expect(html.match(/data-testid="remote-new-menu"/g)?.length).toBe(2);
    expect(html).toContain('aria-label="New in web"');
    // Searched, only what is found shows.
    expect(render("build").split('data-testid="remote-workspace"').slice(1)).toHaveLength(1);
    // Where it lets this one control nothing, no + and no empty workspace.
    const looking = render("", peer);
    expect(looking).not.toContain("remote-new-menu");
    expect(looking.split('data-testid="remote-workspace"').slice(1)).toHaveLength(1);
  });

  test("a row has its right-click menu where its kind of session is controlled from here", () => {
    const render = (serves: string[]) =>
      renderToStaticMarkup(
        <PeerGroup
          peer={{ ...peer, serves }}
          query=""
          sessions={{
            status: "ready",
            list: list([
              session({ tabId: "t1", title: "Fix the build" }),
              session({ tabId: "t2", kind: "terminal", title: "claude", agent: "claude" }),
            ]),
          }}
        />,
      );
    const rows = (html: string) =>
      html
        .split('data-testid="remote-session-row"')
        .slice(0, -1)
        .map((before) => before.slice(before.lastIndexOf("<button")));
    // A menu's trigger tells whether its menu is open.
    const menus = (html: string) => rows(html).map((row) => row.includes('data-state="closed"'));
    expect(menus(render(["sessions"]))).toEqual([false, false]);
    expect(menus(render(["sessions", "chat.control"]))).toEqual([true, false]);
    expect(menus(render(["sessions", "chat.control", "terminal.control"]))).toEqual([true, true]);
  });

  test("only reorders agent rows with a peer that serves it, outside search and within a workspace", () => {
    const sessions = list([
      session({ tabId: "chat", title: "Project chat" }),
      session({ tabId: "terminal", title: "Project terminal", kind: "terminal", agent: "codex" }),
      session({ workspaceId: "w2", tabId: "other", title: "Project elsewhere" }),
    ]);
    const render = (serves: string[], query = "") =>
      renderToStaticMarkup(
        <PeerGroup
          peer={{ ...peer, serves }}
          query={query}
          sessions={{ status: "ready", list: sessions }}
        />,
      );
    const enabled = render(["sessions", "sessions.reorder"]);
    expect(enabled.match(/draggable="true"/g)).toHaveLength(2);
    expect(render(["sessions"])).not.toContain('draggable="true"');
    expect(render(["sessions", "sessions.reorder"], "Project")).not.toContain('draggable="true"');
  });

  test("computer headers and session rows only accept their own drags, within the workspace for sessions", () => {
    const group = { ...peer, serves: ["sessions", "sessions.reorder"] };
    const workspaces = [
      ...list([]).workspaces,
      { id: "task", name: "Task", path: "/task", parentId: "w1" },
    ];
    const sessions = [
      session({ tabId: "a" }),
      session({ tabId: "b", kind: "terminal", agent: "codex" }),
      session({ workspaceId: "task", tabId: "c", state: "running" }),
      session({ workspaceId: "task", tabId: "d", state: "running" }),
    ];
    const hooks = spyOn(sessionDrop, "useSessionDrop");
    const reorder = spyOn(sessionActions, "reorderPeerSessions").mockResolvedValue(false);
    const moveComputer = mock<PeerReorder["move"]>();
    let computerDrag: PeerReorder["drag"] = null;
    const otherComputer = "d3";
    const header = (id: string) => {
      const menu = RemotePeerHeader({
        id,
        expanded: true,
        onToggle: () => {},
        className: "",
        children: id,
        reorder: {
          ids: [group.id, otherComputer],
          drag: computerDrag,
          setDrag: (next) => {
            computerDrag = typeof next === "function" ? next(computerDrag) : next;
          },
          move: moveComputer,
        },
      });
      const [trigger] = menu.props.children as [
        ReactElement<{ children: ReactElement<ComponentProps<"button">> }>,
        ReactElement,
      ];
      return trigger.props.children.props;
    };
    const nativeDrag = () => {
      const payload = new Map<string, string>();
      const dataTransfer = {
        get types() {
          return [...payload.keys()];
        },
        dropEffect: "none",
        setData: (type: string, value: string) => payload.set(type, value),
        getData: (type: string) => payload.get(type) ?? "",
      };
      const preventDefault = mock(() => {});
      const event = {
        clientY: 28,
        currentTarget: { getBoundingClientRect: () => ({ top: 10, height: 20 }) },
        dataTransfer,
        preventDefault,
      } as unknown as DragEvent<HTMLButtonElement>;
      return { event, dataTransfer, preventDefault };
    };
    const globals = globalThis as { document?: unknown };
    const originalDocument = globals.document;
    globals.document ??= { addEventListener() {}, removeEventListener() {} };
    try {
      renderToStaticMarkup(
        <PeerGroup
          peer={group}
          query=""
          sessions={{ status: "ready", list: { workspaces, sessions } }}
        />,
      );
      const handlers = (tabId: string) => {
        const index = hooks.mock.calls.findIndex(([row]) => row.key === tabId);
        const result = hooks.mock.results[index];
        if (!result || result.type !== "return") throw new Error(`no drag handlers for ${tabId}`);
        return result.value.dropProps;
      };
      const row = nativeDrag();
      sessionDrop.startSessionDrag(row.event, { key: "a", deviceId: group.id, workspaceId: "w1" });
      handlers("c").onDrop(row.event);
      expect(reorder).not.toHaveBeenCalled();

      // Even when both targets still have drag state, the native payload must match their kind.
      const computer = nativeDrag();
      header(group.id).onDragStart?.(computer.event);
      const targetHeader = header(otherComputer);
      targetHeader.onDragOver?.(row.event);
      targetHeader.onDrop?.(row.event);
      handlers("b").onDragOver(computer.event);
      handlers("b").onDrop(computer.event);
      expect(moveComputer).not.toHaveBeenCalled();
      expect(reorder).not.toHaveBeenCalled();
      expect(row.preventDefault).not.toHaveBeenCalled();
      expect(computer.preventDefault).not.toHaveBeenCalled();

      targetHeader.onDragOver?.(computer.event);
      expect(computer.dataTransfer.dropEffect).toBe("move");
      targetHeader.onDrop?.(computer.event);
      expect(moveComputer.mock.calls).toEqual([[group.id, otherComputer, "after"]]);
      handlers("b").onDragOver(row.event);
      expect(row.dataTransfer.dropEffect).toBe("move");
      handlers("b").onDrop(row.event);
      expect(reorder).toHaveBeenCalledTimes(1);
      expect(reorder.mock.calls[0]?.slice(0, 3)).toEqual([group.id, "w1", ["b", "a"]]);
    } finally {
      sessionDrop.endSessionDrag();
      globals.document = originalDocument;
      reorder.mockRestore();
      hooks.mockRestore();
    }
  });

  test("the menu renames, then closes, as a tab's here", () => {
    const done: string[] = [];
    const items = remoteSessionMenu({
      rename: () => done.push("rename"),
      close: () => done.push("close"),
    });
    expect(items.map((item) => (item.kind === "item" ? item.label : "—"))).toEqual([
      "Rename Tab…",
      "—",
      "Close",
    ]);
    for (const item of items) if (item.kind === "item") item.onSelect();
    expect(done).toEqual(["rename", "close"]);
  });

  test("its consent prompts come first, before its workspaces", () => {
    const html = renderToStaticMarkup(
      <PeerGroup
        peer={peer}
        query=""
        sessions={{
          status: "ready",
          list: {
            ...list([session({ tabId: "t1", title: "Fix the build" })]),
            consents: [
              {
                id: "c1",
                at: 0,
                expiresAt: 60_000,
                expiresInMs: 30_000,
                from: { device: { id: "d3", name: "Laptop" }, workspaceId: "x", tabId: "y" },
                workspaceId: "w2",
                change: { kind: "chatInput", detail: "Review", body: "Ship it" },
                eachTime: false,
                answerable: true,
              },
              {
                id: "c2",
                at: 0,
                expiresAt: 60_000,
                expiresInMs: 30_000,
                from: { workspaceId: "w1", workspaceName: "api", tabId: "t1", name: "Review" },
                workspaceId: "w2",
                change: { kind: "chatInput", detail: "Build", body: "Run tests" },
                eachTime: false,
                answerable: true,
              },
            ],
          },
        }}
      />,
    );
    expect(html).toContain('data-testid="remote-consent"');
    expect(html).toContain("asks to send a message to the tab &quot;Review&quot; in web.");
    expect(html).toContain("The Claude tab &quot;Review&quot; in api asks to");
    expect(html.indexOf("remote-consent")).toBeLessThan(html.indexOf("remote-workspace"));
  });

  test("what a computer serves, as its hello said; nothing before it said", () => {
    expect(peerServes({ ...peer, serves: ["sessions", "chat.control"] }, "chat.control")).toBe(
      true,
    );
    expect(peerServes(peer, "terminal.control")).toBe(false);
    expect(peerServes({ ...peer, serves: undefined }, "chat.control")).toBe(false);
    expect(peerServes(undefined, "chat.control")).toBe(false);
  });

  test("a session's tab names its computer and title, and its state unless idle", () => {
    const target = {
      deviceId: "d2",
      deviceName: "Work PC",
      workspaceId: "w1",
      workspaceName: "api",
      path: "/src/api",
      tabId: "t1",
      kind: "claude" as const,
      title: "Fix the build",
    };
    const idle = renderToStaticMarkup(<RemoteTabLabel target={{ ...target, state: "idle" }} />);
    expect(idle).toContain("Work PC");
    expect(idle).toContain("Fix the build");
    expect(idle).not.toContain('role="img"');
    const waiting = renderToStaticMarkup(
      <RemoteTabLabel target={{ ...target, state: "needs-you" }} />,
    );
    expect(waiting).toContain('aria-label="Needs you"');
    const ended = renderToStaticMarkup(
      <RemoteTabLabel target={{ ...target, kind: "terminal", state: "ended" }} />,
    );
    expect(ended).toContain('aria-label="Ended"');
    expect(ended).toContain("lucide-circle-x");
  });
});
