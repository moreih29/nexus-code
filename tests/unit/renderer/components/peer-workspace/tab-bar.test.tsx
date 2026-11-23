import { afterEach, expect, spyOn, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { PeerWorkspacePanel } from "../../../../../src/renderer/components/peer-workspace/panel";
import { peerTabMenu } from "../../../../../src/renderer/components/peer-workspace/tab-menu";
import * as workspaceStore from "../../../../../src/renderer/state/stores/peer-workspace";
import { listedRemoteTarget } from "../../../../../src/renderer/state/stores/remote-view";
import type { RoomPeer } from "../../../../../src/shared/remote/room";

const { peerTargetId, usePeerWorkspaceStore } = workspaceStore;
type PeerWorkspaceTarget = workspaceStore.PeerWorkspaceTarget;

const peer: RoomPeer = { id: "desktop", name: "Desktop", online: true, platform: "linux" };
const target: PeerWorkspaceTarget = {
  accountKey: "account",
  deviceId: peer.id,
  deviceName: peer.name,
  platform: peer.platform,
  workspaceId: "repo",
  workspace: { id: "repo", name: "Repo", path: "/repo" },
};
const id = peerTargetId(target);
const previous = usePeerWorkspaceStore.getState();

afterEach(() => usePeerWorkspaceStore.setState(previous, true));

function labels(items: ReturnType<typeof peerTabMenu>): string[] {
  return items.map((item) => (item.kind === "item" ? item.label : "-"));
}

test("a peer tab's menu is the local one's, less what only a local tab can do", () => {
  const noop = () => {};
  const closes = { close: noop, closeOthers: noop, closeToRight: noop, closeAll: noop };
  expect(labels(peerTabMenu(closes))).toEqual([
    "Close",
    "Close Others",
    "Close All to the Right",
    "Close All",
  ]);
  expect(labels(peerTabMenu({ ...closes, rename: noop }))[0]).toBe("Rename Tab…");
  expect(
    labels(peerTabMenu({ ...closes, copyPath: noop, copyRelativePath: noop })).slice(-2),
  ).toEqual(["Copy Path", "Copy Relative Path"]);
});

test("a session tab tells its state as a local tab does", () => {
  usePeerWorkspaceStore.getState().select(target, null);
  usePeerWorkspaceStore.getState().openSession(
    id,
    listedRemoteTarget(peer, target.workspace, {
      kind: "claude",
      tabId: "chat",
      workspaceId: "repo",
      title: "Works",
      state: "running",
    }),
  );
  // Rendered with the store's current state, as the running app does.
  const storeView = spyOn(workspaceStore, "usePeerWorkspaceStore");
  storeView.mockImplementation(
    Object.assign(
      <T,>(select: (state: typeof previous) => T) => select(usePeerWorkspaceStore.getState()),
      usePeerWorkspaceStore,
    ),
  );
  let html: string;
  try {
    html = renderToStaticMarkup(
      <PeerWorkspacePanel
        target={target}
        peer={peer}
        shown
        reach="online"
        reachable
        missing={false}
        updateNeeded={false}
        gitUpdateNeeded={false}
        rejoin={0}
      />,
    );
  } finally {
    storeView.mockRestore();
  }
  expect(html).toContain('aria-label="Running"');
});
