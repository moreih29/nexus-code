/**
 * Scenario tests for merge/rebase workflow target pickers.
 */
import { describe, expect, it, mock } from "bun:test";
import {
  createMergeTargetPickerSource,
  type MergeTargetPickItem,
} from "../../../../../../../src/renderer/components/files/git/pickers/merge-target-picker-source";
import {
  createRebaseTargetPickerSource,
  type RebaseTargetPickItem,
} from "../../../../../../../src/renderer/components/files/git/pickers/rebase-target-picker-source";
import type { BranchList } from "../../../../../../../src/shared/git/types";

const branches: BranchList = {
  current: {
    current: "feature/current",
    upstream: "origin/feature/current",
    ahead: 0,
    behind: 0,
    isUnborn: false,
  },
  local: ["feature/current", "main", "release"],
  remote: ["origin/main", "origin/release"],
};

describe("merge/rebase target picker sources", () => {
  it("omits the current branch and never offers Create new branch", async () => {
    const merge = createMergeTargetPickerSource({
      workspaceId: "ws-1",
      currentBranch: "feature/current",
      listBranches: async () => branches,
      acceptTarget: mock(() => {}),
    });
    const rebase = createRebaseTargetPickerSource({
      workspaceId: "ws-1",
      currentBranch: "feature/current",
      listBranches: async () => branches,
      acceptTarget: mock(() => {}),
    });

    const mergeItems = await searchMerge(merge, "");
    const rebaseItems = await searchRebase(rebase, "");

    expect(merge.id).toBe("git.merge-target-picker");
    expect(merge.title).toBe("Merge branch into feature/current");
    expect(rebase.id).toBe("git.rebase-target-picker");
    expect(rebase.title).toBe("Rebase feature/current onto");
    expect(mergeItems.map((item) => item.label)).toEqual([
      "main",
      "release",
      "origin/main",
      "origin/release",
    ]);
    expect(rebaseItems.map((item) => item.label)).toEqual([
      "main",
      "release",
      "origin/main",
      "origin/release",
    ]);
    expect(mergeItems.some((item) => /Create new branch/i.test(item.label))).toBe(false);
    expect(rebaseItems.some((item) => /Create new branch/i.test(item.label))).toBe(false);
  });

  it("accepts the selected target ref without checkout side effects", async () => {
    const acceptTarget = mock(() => {});
    const source = createMergeTargetPickerSource({
      workspaceId: "ws-1",
      currentBranch: "feature/current",
      listBranches: async () => branches,
      acceptTarget,
    });

    const items = await searchMerge(source, "origin/release");
    const target = items[0];
    if (!target) throw new Error("expected target");
    source.accept(target);

    expect(acceptTarget).toHaveBeenCalledWith("origin/release", target);
  });
});

async function searchMerge(
  source: ReturnType<typeof createMergeTargetPickerSource>,
  query: string,
): Promise<readonly MergeTargetPickItem[]> {
  return source.search(query, new AbortController().signal);
}

async function searchRebase(
  source: ReturnType<typeof createRebaseTargetPickerSource>,
  query: string,
): Promise<readonly RebaseTargetPickItem[]> {
  return source.search(query, new AbortController().signal);
}
