import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { RemoteWorkspace } from "../../../../../packages/remote-protocol/src/rpc";
import { PeerWorkspaceTitle } from "../../../../../src/renderer/components/peer-workspace/title";
import { peerWorkspaceStatus } from "../../../../../src/renderer/components/peer-workspace/workspace-status";
import type { PeerWorkspaceTarget } from "../../../../../src/renderer/state/stores/peer-workspace";

const root: RemoteWorkspace = { id: "repo", name: "Repo", path: "/repo" };
const task: RemoteWorkspace = { id: "task", name: "Fix login", path: "/task", parentId: "repo" };
const target = (workspace: RemoteWorkspace): PeerWorkspaceTarget => ({
  accountKey: "account",
  deviceId: "desktop",
  deviceName: "Desktop",
  platform: "linux",
  workspaceId: workspace.id,
  workspace,
});

test("a task's title is its workspace, a branch mark and the task, as a local one's", () => {
  const html = renderToStaticMarkup(
    <PeerWorkspaceTitle target={target(task)} workspaces={[root, task]} canSelectTask />,
  );
  expect(html.indexOf("Repo")).toBeLessThan(html.indexOf("lucide-git-branch"));
  expect(html.indexOf("lucide-git-branch")).toBeLessThan(html.indexOf("Fix login"));
  expect(html).toContain("Desktop");
});

test("the title is a menu even with no task to switch to", () => {
  const html = renderToStaticMarkup(
    <PeerWorkspaceTitle target={target(root)} workspaces={[root]} canSelectTask={false} />,
  );
  expect(html).toContain('aria-label="Switch task"');
  expect(html).toContain("lucide-chevron-down");
  expect(html).not.toContain("lucide-git-branch");
});

test("a workspace's state in the menu is its most urgent session's", () => {
  const ids = new Set(["repo"]);
  expect(
    peerWorkspaceStatus(
      [
        { kind: "claude", tabId: "a", workspaceId: "repo", title: "", state: "running" },
        {
          kind: "claude",
          tabId: "b",
          workspaceId: "repo",
          title: "",
          state: "needs-you",
          waiting: { kind: "question", text: "Which?" },
        },
        {
          kind: "claude",
          tabId: "c",
          workspaceId: "task",
          title: "",
          state: "running",
          failed: true,
        },
      ],
      ids,
    ),
  ).toBe("needsInput");
  expect(peerWorkspaceStatus([], ids)).toBeNull();
});
