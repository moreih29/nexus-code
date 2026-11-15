import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { RemoteSession } from "../../../../../packages/remote-protocol/src/rpc";
import type { RoomPeer } from "../../../../../src/shared/remote/room";

const {
  OfflinePeer,
  PeerGroup,
  RemoteSessionRow,
  RemoteTabLabel,
  listedByDefault,
  listedSessions,
} = await import("../../../../../src/renderer/components/agent-view/remote-sessions");
const { offlinePeers, servingPeers } = await import(
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
  });

  test("lists a workspace's terminals when asked there, when one is in a panel, or when a search finds one", () => {
    const plain = session({ tabId: "t9", kind: "terminal", title: "dev server" });
    const other = session({ tabId: "t8", workspaceId: "w2", kind: "terminal", title: "logs" });
    const chat = session({ tabId: "t1" });
    const none = () => false;
    const all = [chat, plain, other];
    expect(listedSessions(all, "", none, none)).toEqual({
      listed: [chat],
      hidden: new Map([
        ["w1", 1],
        ["w2", 1],
      ]),
    });
    // Asked for in one workspace: the other's stay out of sight.
    expect(listedSessions(all, "", (w) => w === "w1", none)).toEqual({
      listed: [chat, plain],
      hidden: new Map([["w2", 1]]),
    });
    expect(listedSessions(all, "", none, (s) => s.tabId === "t9").listed).toEqual([chat, plain]);
    expect(listedSessions(all, "server", none, none)).toEqual({
      listed: [plain],
      hidden: new Map(),
    });
  });

  test("each workspace has its own toggle for its terminals, one with only terminals too", () => {
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
    expect(html).toContain("Show 1 terminal");
    expect(html).toContain("Show 2 terminals");
    // The workspace with only terminals is named, for its toggle.
    expect(html).toContain(">web<");
    expect(html).not.toContain("dev server");
    expect(html).not.toContain(">logs<");
    // Its toggle comes under its own sessions, not the computer's last.
    expect(html.indexOf("Show 1 terminal")).toBeLessThan(html.indexOf(">web<"));
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
