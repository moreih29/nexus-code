import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  peerGitCounts,
  peerGitGroups,
} from "../../../../../src/renderer/components/peer-workspace/git-groups";
import { PeerStatusBar } from "../../../../../src/renderer/components/peer-workspace/status-bar";
import type { PeerGitStatus } from "../../../../../src/renderer/services/remote/peer-git-status";
import type { PeerWorkspaceTarget } from "../../../../../src/renderer/state/stores/peer-workspace";

const target: PeerWorkspaceTarget = {
  accountKey: "account",
  deviceId: "desktop",
  deviceName: "Desktop",
  platform: "linux",
  workspaceId: "repo",
  workspace: { id: "repo", name: "Repo", path: "/repo" },
};

const files: PeerGitStatus["files"] = [
  { path: "both.ts", staged: "M", unstaged: "M" },
  { path: "staged.ts", staged: "A" },
  { path: "changed.ts", unstaged: "D" },
  { path: "new.ts", unstaged: "?" },
  { path: "conflict.ts", staged: "U", unstaged: "U" },
  { path: "added-both.ts", staged: "A", unstaged: "A" },
];

test("peer changes fall into the local Source Control groups", () => {
  const groups = peerGitGroups(files);
  expect(groups.merge.map((f) => f.path)).toEqual(["conflict.ts", "added-both.ts"]);
  expect(groups.staged.map((f) => f.path)).toEqual(["both.ts", "staged.ts"]);
  expect(groups.working.map((f) => f.path)).toEqual(["both.ts", "changed.ts"]);
  expect(groups.untracked.map((f) => f.path)).toEqual(["new.ts"]);
  expect(peerGitCounts(files)).toEqual({ conflict: 2, staged: 2, modified: 2, untracked: 1 });
});

test("the peer status bar tells the branch against its upstream and the changes by state", () => {
  const html = renderToStaticMarkup(
    <PeerStatusBar
      target={target}
      status={{ branch: "main", ahead: 1, behind: 2, files }}
      gitError={undefined}
    />,
  );
  expect(html).toContain("Desktop");
  expect(html).toContain("main ↑1 ↓2");
  // The changes are one button, conflicts first, each state its own count.
  expect(html).toMatch(/<button[^>]*title="[^"]*2[^"]*"/);
  expect(html.indexOf("--status-bar-conflict-fg")).toBeLessThan(
    html.indexOf("--status-bar-added-fg"),
  );
  expect(html).toContain("--status-bar-untracked-fg");
  // The bar's items are the local bar's size.
  expect(html).toContain("text-app-ui-sm");
  expect(html).not.toContain("text-app-micro");
});

test("a clean tree shows no changes, a detached head says so, and no repository says no git", () => {
  const clean = renderToStaticMarkup(
    <PeerStatusBar
      target={target}
      status={{ branch: null, ahead: 0, behind: 0, files: [] }}
      gitError={undefined}
    />,
  );
  expect(clean).not.toContain("<button");
  expect(clean).not.toContain("↑");
  const none = renderToStaticMarkup(
    <PeerStatusBar target={target} status={undefined} gitError="not-found" />,
  );
  expect(none).toContain("opacity-50");
  const unreadable = renderToStaticMarkup(
    <PeerStatusBar target={target} status={undefined} gitError="unavailable" />,
  );
  expect(unreadable).not.toContain("opacity-50");
});
