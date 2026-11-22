import { expect, spyOn, test } from "bun:test";
import { Tabs } from "radix-ui";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { PeerDiffView } from "../../../../../src/renderer/components/peer-workspace/diff-model";
import { PeerDiffTabBody } from "../../../../../src/renderer/components/peer-workspace/diff-tab";
import { PeerGitPanel } from "../../../../../src/renderer/components/peer-workspace/git-panel";
import {
  type PeerDiffTab,
  type PeerWorkspaceTarget,
  peerTabId,
} from "../../../../../src/renderer/state/stores/peer-workspace";

const target: PeerWorkspaceTarget = {
  accountKey: "account",
  deviceId: "peer",
  deviceName: "Desktop",
  platform: "linux",
  workspaceId: "repo",
  workspace: { id: "repo", name: "Repo", path: "/repo" },
};
const tab: PeerDiffTab = {
  type: "peer.diff",
  path: "src/main.ts",
  unstaged: "M",
  side: "unstaged",
};

test("the working diff tab shows when the server cut the patch", () => {
  const patch: PeerDiffView = {
    kind: "patch",
    patch: { path: tab.path, truncated: true, hunks: [] },
  };
  const renderState = React.useState;
  let injected = false;
  const loaded = spyOn(React, "useState").mockImplementation((initial) => {
    const usePatch = initial === null && !injected;
    injected ||= usePatch;
    return renderState(usePatch ? patch : initial);
  });
  try {
    const markup = renderToStaticMarkup(
      <Tabs.Root value={encodeURIComponent(peerTabId(tab))}>
        <PeerDiffTabBody
          target={target}
          tab={tab}
          selected
          canRead={false}
          updateNeeded={false}
          rejoin={0}
        />
      </Tabs.Root>,
    );
    expect(markup).toContain("Partial patch");
    expect(markup).toContain(">Reload</button>");
    expect(markup).not.toContain("Refresh Explorer");
  } finally {
    loaded.mockRestore();
  }
});

test("the peer Git panel uses the source control refresh label", () => {
  const markup = renderToStaticMarkup(
    <PeerGitPanel target={target} canRead updateNeeded={false} refresh={() => {}} />,
  );
  expect(markup).toContain('aria-label="Refresh source control"');
  expect(markup).not.toContain("Refresh Explorer");
});
