/** Another computer's changes, by side: each group leads with its chevron, as a tree's heading. */
import { expect, spyOn, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { PeerGitPanel } from "../../../../../src/renderer/components/peer-workspace/git-panel";
import * as peerStore from "../../../../../src/renderer/state/stores/peer-workspace";

const target: peerStore.PeerWorkspaceTarget = {
  accountKey: "account",
  deviceId: "device",
  deviceName: "Desktop",
  platform: "linux",
  workspaceId: "workspace",
  workspace: { id: "workspace", name: "Workspace", path: "/home/demo" },
};

test("a group of changes folds by a heading that leads with its chevron, no platform triangle", () => {
  const initial = peerStore.usePeerWorkspaceStore.getInitialState();
  const state = {
    ...initial,
    views: {
      [peerStore.peerTargetId(target)]: {
        ...peerStore.EMPTY_PEER_VIEW,
        gitStatus: {
          branch: "main",
          ahead: 0,
          behind: 0,
          files: [{ path: "/home/demo/a.txt", staged: "M" as const }],
        },
      },
    },
  };
  const store = spyOn(peerStore, "usePeerWorkspaceStore").mockImplementation(((
    select: (s: typeof state) => unknown,
  ) => select(state)) as never);
  try {
    const html = renderToStaticMarkup(
      <PeerGitPanel target={target} canRead updateNeeded={false} refresh={() => {}} rejoin={0} />,
    );
    const summary = html.match(/<summary([^>]*)>(.*?)<\/summary>/);
    expect(summary?.[1]).toContain("list-none");
    expect(summary?.[2]).toMatch(/^<svg[^>]*lucide-chevron-right/);
  } finally {
    store.mockRestore();
  }
});
