import { describe, expect, test } from "bun:test";

import type {
  GitBranch,
  GitStatusSummary,
} from "../../../../shared/src/contracts/generated/git-lifecycle";
import type { WorkspaceId } from "../../../../shared/src/contracts/workspace/workspace";
import {
  createSourceControlStore,
  getSourceControlFileGroups,
  sourceControlStateLabel,
  type SourceControlBridge,
  type SourceControlBridgeEvent,
  type SourceControlBridgeRequest,
  type SourceControlBridgeResult,
} from "./source-control-store";

const workspaceId = "ws_alpha" as WorkspaceId;
const cwd = "/tmp/alpha";

const changedSummary: GitStatusSummary = {
  branch: "main",
  upstream: "origin/main",
  ahead: 1,
  behind: 2,
  files: [
    entry("src/changed.ts", " M", "modified"),
    entry("src/staged.ts", "A ", "added"),
    entry("src/both.ts", "MM", "modified"),
    entry("src/conflict.ts", "UU", "conflicted"),
    entry("scratch.txt", "??", "untracked"),
  ],
};

const cleanSummary: GitStatusSummary = {
  branch: "main",
  upstream: null,
  ahead: 0,
  behind: 0,
  files: [],
};

const branches: GitBranch[] = [
  { name: "main", current: true, upstream: "origin/main", headOid: "abc" },
  { name: "feature", current: false, upstream: null, headOid: "def" },
];

describe("source-control-store", () => {
  test("groups changes, staged files, and conflicts", () => {
    const groups = getSourceControlFileGroups(changedSummary);

    expect(groups.find((group) => group.id === "changes")?.entries.map((entry) => entry.path)).toEqual([
      "src/changed.ts",
      "src/both.ts",
      "scratch.txt",
    ]);
    expect(groups.find((group) => group.id === "staged")?.entries.map((entry) => entry.path)).toEqual([
      "src/staged.ts",
      "src/both.ts",
    ]);
    expect(groups.find((group) => group.id === "conflicts")?.entries.map((entry) => entry.path)).toEqual([
      "src/conflict.ts",
    ]);
    expect(sourceControlStateLabel(changedSummary)).toBe("conflict");
    expect(sourceControlStateLabel(cleanSummary)).toBe("clean");
  });

  test("refreshes status, loads branches, stages paths, and applies replies", async () => {
    const bridge = new FakeGitBridge();
    const store = createSourceControlStore(bridge);

    await store.getState().refreshStatus({ workspaceId, cwd });
    await store.getState().loadBranches({ workspaceId, cwd });
    await store.getState().stagePaths({ workspaceId, cwd }, ["src/changed.ts"]);

    expect(bridge.calls.map((call) => call.action)).toEqual(["status", "branch_list", "stage"]);
    expect(bridge.calls[2]).toMatchObject({ paths: ["src/changed.ts"] });
    expect(store.getState().getWorkspaceState(workspaceId).summary).toEqual(cleanSummary);
    expect(store.getState().getWorkspaceState(workspaceId).branches).toEqual(branches);
  });

  test("commits with amend flag and clears the commit message", async () => {
    const bridge = new FakeGitBridge();
    const store = createSourceControlStore(bridge);

    store.getState().setCommitMessage(workspaceId, "fix: update panel");
    await store.getState().commit({ workspaceId, cwd }, { amend: true });

    expect(bridge.calls[0]).toMatchObject({
      action: "commit",
      message: "fix: update panel",
      amend: true,
    });
    const workspace = store.getState().getWorkspaceState(workspaceId);
    expect(workspace.commitMessage).toBe("");
    expect(workspace.commitHistory).toEqual(["commit123"]);
  });

  test("opens a dirty checkout warning before destructive checkout", async () => {
    const bridge = new FakeGitBridge();
    const store = createSourceControlStore(bridge);
    store.getState().applyBridgeEvent({
      type: "git/lifecycle",
      action: "status_result",
      requestId: "status-1",
      workspaceId,
      cwd,
      summary: changedSummary,
      generatedAt: "2026-04-28T00:00:00.000Z",
    });

    await store.getState().checkoutBranch({ workspaceId, cwd }, "feature");
    expect(store.getState().getWorkspaceState(workspaceId).pendingCheckout).toEqual({
      ref: "feature",
      dirtyFileCount: 5,
    });
    expect(bridge.calls).toEqual([]);

    await store.getState().checkoutBranch({ workspaceId, cwd }, "feature", { discardDirty: true });
    expect(bridge.calls.map((call) => call.action)).toEqual(["discard", "checkout"]);
  });
});

function entry(path: string, status: string, kind: GitStatusSummary["files"][number]["kind"]): GitStatusSummary["files"][number] {
  return {
    path,
    originalPath: null,
    status,
    indexStatus: status.slice(0, 1),
    workTreeStatus: status.slice(1, 2),
    kind,
  };
}

class FakeGitBridge implements SourceControlBridge {
  public readonly calls: SourceControlBridgeRequest[] = [];
  private listener: ((event: SourceControlBridgeEvent) => void) | null = null;

  public invoke(request: SourceControlBridgeRequest): Promise<SourceControlBridgeResult> {
    this.calls.push(request);
    switch (request.action) {
      case "status":
        return Promise.resolve({
          type: "git/lifecycle",
          action: "status_result",
          requestId: request.requestId,
          workspaceId: request.workspaceId,
          cwd: request.cwd,
          summary: changedSummary,
          generatedAt: "2026-04-28T00:00:00.000Z",
        });
      case "branch_list":
        return Promise.resolve({
          type: "git/lifecycle",
          action: "branch_list_result",
          requestId: request.requestId,
          workspaceId: request.workspaceId,
          cwd: request.cwd,
          branches,
          generatedAt: "2026-04-28T00:00:00.000Z",
        });
      case "stage":
        return Promise.resolve({
          type: "git/lifecycle",
          action: "stage_result",
          requestId: request.requestId,
          workspaceId: request.workspaceId,
          cwd: request.cwd,
          summary: cleanSummary,
          completedAt: "2026-04-28T00:00:00.000Z",
        });
      case "discard":
        return Promise.resolve({
          type: "git/lifecycle",
          action: "discard_result",
          requestId: request.requestId,
          workspaceId: request.workspaceId,
          cwd: request.cwd,
          summary: cleanSummary,
          completedAt: "2026-04-28T00:00:00.000Z",
        });
      case "checkout":
        return Promise.resolve({
          type: "git/lifecycle",
          action: "checkout_result",
          requestId: request.requestId,
          workspaceId: request.workspaceId,
          cwd: request.cwd,
          summary: cleanSummary,
          completedAt: "2026-04-28T00:00:00.000Z",
        });
      case "commit":
        return Promise.resolve({
          type: "git/lifecycle",
          action: "commit_result",
          requestId: request.requestId,
          workspaceId: request.workspaceId,
          cwd: request.cwd,
          commitOid: "commit123",
          summary: cleanSummary,
          completedAt: "2026-04-28T00:00:00.000Z",
        });
      case "unstage":
        return Promise.resolve({
          type: "git/lifecycle",
          action: "unstage_result",
          requestId: request.requestId,
          workspaceId: request.workspaceId,
          cwd: request.cwd,
          summary: changedSummary,
          completedAt: "2026-04-28T00:00:00.000Z",
        });
      case "branch_create":
        return Promise.resolve({
          type: "git/lifecycle",
          action: "branch_create_result",
          requestId: request.requestId,
          workspaceId: request.workspaceId,
          cwd: request.cwd,
          branches,
          completedAt: "2026-04-28T00:00:00.000Z",
        });
      case "branch_delete":
        return Promise.resolve({
          type: "git/lifecycle",
          action: "branch_delete_result",
          requestId: request.requestId,
          workspaceId: request.workspaceId,
          cwd: request.cwd,
          branches,
          completedAt: "2026-04-28T00:00:00.000Z",
        });
      case "diff":
        return Promise.resolve({
          type: "git/lifecycle",
          action: "diff_result",
          requestId: request.requestId,
          workspaceId: request.workspaceId,
          cwd: request.cwd,
          staged: request.staged,
          paths: request.paths,
          diff: "diff --git a/file b/file",
          generatedAt: "2026-04-28T00:00:00.000Z",
        });
      case "watch_start":
        return Promise.resolve({
          type: "git/lifecycle",
          action: "watch_started",
          requestId: request.requestId,
          workspaceId: request.workspaceId,
          cwd: request.cwd,
          watchId: request.watchId,
          watchedPaths: [request.cwd],
          startedAt: "2026-04-28T00:00:00.000Z",
        });
      case "watch_stop":
        return Promise.resolve({
          type: "git/lifecycle",
          action: "watch_stopped",
          requestId: request.requestId,
          workspaceId: request.workspaceId,
          watchId: request.watchId,
          stoppedAt: "2026-04-28T00:00:00.000Z",
        });
    }
  }

  public onEvent(listener: (event: SourceControlBridgeEvent) => void) {
    this.listener = listener;
    return {
      dispose: () => {
        this.listener = null;
      },
    };
  }

  public emit(event: SourceControlBridgeEvent): void {
    this.listener?.(event);
  }
}
