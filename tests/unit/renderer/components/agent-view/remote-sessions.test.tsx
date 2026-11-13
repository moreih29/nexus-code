import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { RemoteSession } from "../../../../../packages/remote-protocol/src/rpc";
import type { RoomPeer } from "../../../../../src/shared/remote/room";

const { PeerGroup, RemoteSessionRow } = await import(
  "../../../../../src/renderer/components/agent-view/remote-sessions"
);
const { servingPeers } = await import("../../../../../src/renderer/services/remote/room");

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

  test("names the computer and its system, and its sessions by workspace", () => {
    const html = renderToStaticMarkup(
      <PeerGroup
        peer={peer}
        query=""
        sessions={{
          status: "ready",
          list: list([
            session({ tabId: "t1", title: "Fix the build", last: "Done." }),
            session({ tabId: "t2", workspaceId: "w2", kind: "terminal", title: "dev server" }),
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
    expect(html).toContain("dev server");
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
});
