/**
 * Scenario tests for the single-pick cherry-pick commit picker.
 */
import { describe, expect, it, mock } from "bun:test";
import {
  type CommitPickItem,
  createCommitPickerSource,
} from "../../../../../../src/renderer/components/files/git/commit-picker-source";
import type { LogEntry } from "../../../../../../src/shared/types/git";

const commit: LogEntry = {
  sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  shortSha: "aaaaaaa",
  parents: ["bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"],
  authorName: "Ada",
  authorEmail: "ada@example.invalid",
  authoredAt: new Date(Date.now() - 60_000).toISOString(),
  subject: "fix conflict marker cleanup",
  body: "details",
};

describe("createCommitPickerSource", () => {
  it("starts on the current branch commits and exposes the other-branch flow", async () => {
    const listRecentCommits = mock(async () => [commit]);
    const source = createCommitPickerSource({
      workspaceId: "ws-1",
      currentBranch: "main",
      listRecentCommits,
      acceptCommit: mock(() => {}),
      requestBranch: mock(() => {}),
    });

    const items = await search(source, "");

    expect(source.id).toBe("git.commit-picker");
    expect(source.title).toBe("Pick from main");
    expect(listRecentCommits).toHaveBeenCalledWith("ws-1", expect.any(AbortSignal), undefined);
    expect(items.map((item) => item.label)).toEqual([
      "fix conflict marker cleanup",
      "Pick from another branch…",
    ]);
    expect(items[0]?.kindLabel).toBe("aaaaaaa");
  });

  it("retargets commit listing to the selected branch ref", async () => {
    const listRecentCommits = mock(async () => [commit]);
    const source = createCommitPickerSource({
      workspaceId: "ws-1",
      currentBranch: "main",
      ref: "release",
      listRecentCommits,
      acceptCommit: mock(() => {}),
      requestBranch: mock(() => {}),
    });

    await search(source, "");

    expect(source.title).toBe("Pick from release");
    expect(listRecentCommits).toHaveBeenCalledWith("ws-1", expect.any(AbortSignal), "release");
  });

  it("accepts only one commit or opens the branch flow", async () => {
    const acceptCommit = mock(() => {});
    const requestBranch = mock(() => {});
    const source = createCommitPickerSource({
      workspaceId: "ws-1",
      currentBranch: "main",
      listRecentCommits: mock(async () => [commit]),
      acceptCommit,
      requestBranch,
    });
    const items = await search(source, "");
    const commitItem = items[0];
    const branchItem = items[1];
    if (!commitItem || !branchItem) throw new Error("expected commit and branch rows");

    source.accept(commitItem);
    source.accept(branchItem);

    expect(acceptCommit).toHaveBeenCalledWith(commit.sha, commitItem);
    expect(requestBranch).toHaveBeenCalledTimes(1);
  });
});

async function search(
  source: ReturnType<typeof createCommitPickerSource>,
  query: string,
): Promise<readonly CommitPickItem[]> {
  return source.search(query, new AbortController().signal);
}
