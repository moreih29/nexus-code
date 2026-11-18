import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { RemoteSession } from "../../../../../packages/remote-protocol/src/rpc";
import type { RoomPeer } from "../../../../../src/shared/remote/room";

const {
  HungTerminals,
  OfflinePeer,
  PeerGroup,
  RemoteSessionRow,
  RemoteTabLabel,
  agentRunsOf,
  listedByDefault,
  listedSessions,
  remoteSessionMenu,
} = await import("../../../../../src/renderer/components/agent-view/remote-sessions");
const { offlinePeers, peerServes, servingPeers } = await import(
  "../../../../../src/renderer/services/remote/room"
);

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

describe("the agent view's other computers", () => {
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
    // One that ended is a terminal again, as an agent here whose terminal ended.
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
      html.indexOf("<button", html.indexOf('data-testid="remote-workspace"')),
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
              session({ tabId: "t2", workspaceId: "w2", title: "Fix login" }),
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

  test("hangs a task from a line under its workspace's folder, where that is listed", () => {
    const render = (sessions: RemoteSession[]) =>
      renderToStaticMarkup(
        <PeerGroup
          peer={peer}
          query=""
          sessions={{
            status: "ready",
            list: {
              workspaces: [
                { id: "w1", name: "api", path: "/src/api" },
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
    const both = groups(
      render([
        session({ tabId: "t1", title: "Fix the build" }),
        session({ tabId: "t2", workspaceId: "w2", title: "Fix login" }),
      ]),
    );
    expect(both).toHaveLength(2);
    expect(both[0]).not.toContain("data-task");
    expect(both[1]).toContain("data-task");
    expect(both[1]).toContain("ml-3.5 border-border border-l");
    // Its workspace not listed, it has nothing to hang from.
    const alone = groups(render([session({ tabId: "t2", workspaceId: "w2", title: "Fix login" })]));
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
    expect(render({ status: "unavailable" })).toContain("Not answering");
    expect(render({ status: "ready", list: list([]) })).toContain("No sessions");
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
            ],
          },
        }}
      />,
    );
    expect(html).toContain('data-testid="remote-consent"');
    expect(html).toContain("asks to send a message to the tab &quot;Review&quot; in web.");
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
  });
});
