import { describe, expect, test } from "bun:test";

import type {
  GitBranch,
  GitStatusEntry,
  GitStatusSummary,
} from "../../../../shared/src/contracts/generated/git-lifecycle";
import type { WorkspaceId } from "../../../../shared/src/contracts/workspace/workspace";
import { createGitService } from "./git-service";

const workspaceId = "ws_git" as WorkspaceId;
const otherWorkspaceId = "ws_git_other" as WorkspaceId;
const cwd = "/tmp/git";

const branches: GitBranch[] = [
  { name: "main", current: true, upstream: "origin/main", headOid: "abc" },
  { name: "feature", current: false, upstream: null, headOid: "def" },
];

const summary: GitStatusSummary = {
  branch: "main",
  upstream: "origin/main",
  ahead: 1,
  behind: 2,
  files: [
    entry("src/modified.ts", " M", "modified"),
    entry("src/staged.ts", "A ", "added"),
    entry("src/conflict.ts", "UU", "conflicted"),
    entry("src/copied.ts", "A ", "copied"),
    entry("src/clean.ts", "  ", "clean"),
  ],
};

describe("git-service", () => {
  test("manages status, operation, summaries, path statuses, path badges, and branch getters", () => {
    const store = createGitService();

    store.getState().setStatus("loading");
    store.getState().setOperation("status");
    expect(store.getState()).toMatchObject({ status: "loading", operation: "status" });

    store.getState().applySummary(workspaceId, summary);
    expect(store.getState()).toMatchObject({
      workspaceId,
      status: "ready",
      operation: null,
      summary,
      errorMessage: null,
    });
    expect(store.getState().getBranchName()).toBe("main");
    expect(store.getState().getPathStatus("src/modified.ts")).toEqual(summary.files[0]);
    expect(store.getState().getPathStatus("missing.ts")).toBeNull();
    expect(store.getState().getPathBadge("src/modified.ts")).toBe("modified");
    expect(store.getState().getPathBadge("src/staged.ts")).toBe("staged");
    expect(store.getState().getPathBadge("src/conflict.ts")).toBe("conflicted");
    expect(store.getState().getPathBadge("src/copied.ts")).toBe("staged");
    expect(store.getState().getPathBadge("src/clean.ts")).toBeNull();

    store.getState().setBranches(workspaceId, branches);
    expect(store.getState().getCurrentBranch()).toEqual(branches[0]);
  });

  test("applies status, branch-list, relay, failed, and watch result adapters", () => {
    const store = createGitService();

    store.getState().applyStatusResult({
      type: "git/lifecycle",
      action: "status_result",
      requestId: "status-1",
      workspaceId,
      cwd,
      summary,
      generatedAt: "2026-04-28T00:00:00.000Z",
    });
    expect(store.getState()).toMatchObject({
      workspaceId,
      cwd,
      status: "ready",
      lastStatusAt: "2026-04-28T00:00:00.000Z",
    });

    store.getState().applyBranchListResult({
      type: "git/lifecycle",
      action: "branch_list_result",
      requestId: "branch-1",
      workspaceId,
      cwd,
      branches,
      generatedAt: "2026-04-28T00:00:01.000Z",
    });
    expect(store.getState().branches).toEqual(branches);

    store.getState().applyStatusResult({
      type: "git/relay",
      kind: "status_change",
      workspaceId,
      watchId: "watch-1",
      cwd,
      seq: 1,
      summary: { ...summary, branch: "feature" },
      changedAt: "2026-04-28T00:00:02.000Z",
    });
    expect(store.getState()).toMatchObject({
      watchId: "watch-1",
      bridgeStatus: "connected",
      lastStatusAt: "2026-04-28T00:00:02.000Z",
    });
    expect(store.getState().getBranchName()).toBe("feature");

    store.getState().applyWatchStarted({
      type: "git/lifecycle",
      action: "watch_started",
      requestId: "watch-start-1",
      workspaceId,
      cwd,
      watchId: "watch-2",
      watchedPaths: [cwd],
      startedAt: "2026-04-28T00:00:03.000Z",
    });
    expect(store.getState()).toMatchObject({ watchId: "watch-2", bridgeStatus: "connected" });

    store.getState().applyWatchStopped({
      type: "git/lifecycle",
      action: "watch_stopped",
      requestId: "watch-stop-1",
      workspaceId,
      watchId: "watch-2",
      stoppedAt: "2026-04-28T00:00:04.000Z",
    });
    expect(store.getState().watchId).toBeNull();

    store.getState().applyFailedEvent({
      type: "git/lifecycle",
      action: "failed",
      failedAction: "status",
      requestId: "status-2",
      workspaceId,
      cwd,
      state: "error",
      message: "git failed",
      exitCode: 128,
      stderr: "fatal",
      failedAt: "2026-04-28T00:00:05.000Z",
    });
    expect(store.getState()).toMatchObject({
      status: "failed",
      operation: null,
      errorMessage: "git failed",
      lastStatusAt: "2026-04-28T00:00:05.000Z",
    });
  });

  test("manages selection, bridge state, sidecar state, errors, and clear", () => {
    const store = createGitService();

    store.getState().selectPath("src/a.ts");
    expect(store.getState().selectedPaths).toEqual(["src/a.ts"]);

    store.getState().selectPaths(["src/a.ts", "src/b.ts", "src/a.ts"]);
    expect(store.getState().selectedPaths).toEqual(["src/a.ts", "src/b.ts"]);

    store.getState().togglePathSelection("src/b.ts");
    expect(store.getState().selectedPaths).toEqual(["src/a.ts"]);

    store.getState().togglePathSelection("src/c.ts");
    expect(store.getState().selectedPaths).toEqual(["src/a.ts", "src/c.ts"]);

    store.getState().clearSelection();
    expect(store.getState().selectedPaths).toEqual([]);

    store.getState().setBridgeStatus("connecting", "subscribing");
    store.getState().setSidecarStatus("starting", "launching sidecar");
    expect(store.getState()).toMatchObject({
      bridgeStatus: "connecting",
      bridgeStatusMessage: "subscribing",
      sidecarStatus: "starting",
      sidecarStatusMessage: "launching sidecar",
    });

    store.getState().setError("manual failure");
    expect(store.getState()).toMatchObject({
      status: "failed",
      operation: null,
      errorMessage: "manual failure",
    });

    store.getState().clear();
    expect(store.getState()).toMatchObject({
      workspaceId: null,
      cwd: null,
      status: "idle",
      summary: null,
      branches: [],
      selectedPaths: [],
      bridgeStatus: "disconnected",
      sidecarStatus: "unknown",
      errorMessage: null,
    });
  });

  test("owns file-tree path badge updates independent of status summaries", () => {
    const store = createGitService();

    store.getState().replacePathBadges(workspaceId, { "src/index.ts": "modified" });
    store.getState().setPathBadge("src/added.ts", "added");
    store.getState().setPathBadge("src/index.ts", "clean");
    store.getState().applyPathBadges(otherWorkspaceId, [
      { path: "other.ts", status: "conflicted" },
    ]);
    store.getState().applyPathBadgesResult({
      type: "workspace-git-badges/read/result",
      workspaceId: otherWorkspaceId,
      badges: [
        { path: "other.ts", status: "clean" },
        { path: "next.ts", status: "untracked" },
      ],
      readAt: "2026-04-29T00:00:00.000Z",
    });

    expect(store.getState().workspaceId).toBe(otherWorkspaceId);
    expect(store.getState().pathBadgeByPath).toEqual({ "next.ts": "untracked" });
  });
});

function entry(path: string, status: string, kind: GitStatusEntry["kind"]): GitStatusEntry {
  return {
    path,
    originalPath: null,
    status,
    indexStatus: status.slice(0, 1),
    workTreeStatus: status.slice(1, 2),
    kind,
  };
}
