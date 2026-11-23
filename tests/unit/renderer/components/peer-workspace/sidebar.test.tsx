import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { peerTarget } from "../../../../../src/renderer/components/peer-workspace/room";
import { PeerWorkspaceSection } from "../../../../../src/renderer/components/peer-workspace/sidebar";
import { orderPeers } from "../../../../../src/renderer/services/agent-view/order";
import type { PeerSessions } from "../../../../../src/renderer/services/remote/room";
import type { RoomPeer } from "../../../../../src/shared/remote/room";

const mac: RoomPeer = { id: "mac", name: "Studio Mac", platform: "darwin", online: true };
const build: RoomPeer = { id: "build", name: "Build Server", platform: "linux", online: true };
const pc: RoomPeer = { id: "pc", name: "Work PC", platform: "win32", online: false };
const pinned = { id: "pin", name: "Pinned app", path: "c:\\home\\projects\\client", pinned: true };
const regular = { id: "regular", name: "Project docs", path: "/home/projects/docs" };
const task = {
  id: "task",
  name: "Hidden task",
  parentId: pinned.id,
  path: "C:\\tasks\\one",
  git: { branch: "task/one", uncommitted: 3, ahead: 0, behind: 0 },
};
const lists: Record<string, PeerSessions> = {
  mac: { status: "ready", list: { sessions: [], workspaces: [pinned, task, regular] } },
  build: {
    status: "ready",
    list: { sessions: [], workspaces: [{ ...regular, name: "Build app" }] },
  },
};
const render = (folded: string[], missing = false) =>
  renderToStaticMarkup(
    <PeerWorkspaceSection
      accountKey="account"
      online={orderPeers([mac, build], ["build", "mac"])}
      offline={[pc]}
      lists={lists}
      active={peerTarget("account", mac, pinned)}
      missing={missing}
      folded={folded}
      toggleFold={() => {}}
    />,
  );

test("the sidebar keeps the device and served workspace orders, with tasks under their root", () => {
  const html = render([]);
  expect(html.indexOf("Build Server")).toBeLessThan(html.indexOf("Studio Mac"));
  expect(html.indexOf("Pinned app")).toBeLessThan(html.indexOf("Project docs"));
  expect(html).toContain('aria-expanded="true"');
  expect(html).toContain('aria-current="page"');
  expect(html).toContain("projects/client");
  expect(html).not.toContain("Hidden task");
  expect(html).not.toContain("task/one");
  expect(html).not.toContain("draggable=");
});

test("folded and offline devices hide workspace rows; a removed selection disappears", () => {
  const html = render(["build"]);
  expect(html).toContain('aria-expanded="false"');
  expect(html).not.toContain("Build app");
  expect(html).toContain("Work PC");
  expect(html).toContain("Offline");
  expect(html.match(/<button/g)).toHaveLength(4);
  expect(render([], true)).not.toContain("Pinned app");
});

test("a workspace's row tells its tasks, its pin, and where its sessions stand, as a local card", () => {
  const html = renderToStaticMarkup(
    <PeerWorkspaceSection
      accountKey="account"
      online={[mac]}
      offline={[]}
      lists={{
        mac: {
          status: "ready",
          list: {
            workspaces: [pinned, task, regular],
            sessions: [
              {
                kind: "claude",
                tabId: "asks",
                workspaceId: task.id,
                title: "Asks",
                state: "needs-you",
                since: 2,
                waiting: { kind: "permission", text: "Run tools?" },
              },
              {
                kind: "codex",
                tabId: "said",
                workspaceId: pinned.id,
                title: "Said",
                state: "new-result",
                since: 3,
                last: "**Done** with the fix",
              },
              {
                kind: "claude",
                tabId: "other",
                workspaceId: regular.id,
                title: "x",
                state: "idle",
              },
            ],
          },
        },
      }}
      active={null}
      folded={[]}
      toggleFold={() => {}}
    />,
  );
  const [pinnedRow, regularRow] = html.split("Project docs");
  expect(pinnedRow).toContain("1 task");
  expect(pinnedRow).toContain('aria-label="Pinned"');
  // The task's permission ask is the row's state; the latest message its line.
  expect(pinnedRow).toContain("border-l-[var(--state-warning-fg)]");
  expect(pinnedRow).toContain("Done with the fix");
  expect(regularRow).not.toContain('aria-label="Pinned"');
  expect(regularRow).not.toContain("task");
});
