/**
 * Scenario tests for BranchChip glyphs and branch action menus.
 */
import { describe, expect, it } from "bun:test";
import { branchChipGlyph } from "../../../../../../src/renderer/components/files/git/BranchChip";
import {
  buildGitBranchContextMenuModel,
  getGitBranchPrimaryAction,
} from "../../../../../../src/renderer/components/files/git/GitBranchPopover";
import type { BranchInfo, RepoCapabilities } from "../../../../../../src/shared/types/git";

const capabilities: RepoCapabilities = {
  hasHEAD: true,
  remotes: ["origin"],
  stashCount: 0,
  tagCount: 0,
};

function branch(overrides: Partial<BranchInfo> = {}): BranchInfo {
  return {
    current: "main",
    upstream: "origin/main",
    ahead: 0,
    behind: 0,
    isUnborn: false,
    ...overrides,
  };
}

describe("BranchChip glyph model", () => {
  it("renders ahead, behind, diverged, no-upstream, fetching, and failed states", () => {
    expect(branchChipGlyph({ branch: branch({ ahead: 2 }) })).toBe("↑2");
    expect(branchChipGlyph({ branch: branch({ behind: 3 }) })).toBe("↓3");
    expect(branchChipGlyph({ branch: branch({ ahead: 2, behind: 3 }) })).toBe("↓3 ↑2");
    expect(branchChipGlyph({ branch: branch({ ahead: 2, behind: 3 }), narrow: true })).toBe("↕2/3");
    expect(branchChipGlyph({ branch: branch({ upstream: null }) })).toBe("⊘");
    expect(branchChipGlyph({ branch: branch(), fetching: true })).toBe("⟳");
    expect(branchChipGlyph({ branch: branch(), failed: true })).toBe("!");
  });
});

describe("GitBranchPopover action model", () => {
  it("chooses exactly one primary CTA for sync states", () => {
    expect(getGitBranchPrimaryAction({ branch: branch({ behind: 1 }), capabilities }).label).toBe(
      "Pull",
    );
    expect(getGitBranchPrimaryAction({ branch: branch({ ahead: 1 }), capabilities }).label).toBe(
      "Push",
    );
    expect(
      getGitBranchPrimaryAction({ branch: branch({ ahead: 1, behind: 1 }), capabilities }).label,
    ).toBe("Sync");
    expect(
      getGitBranchPrimaryAction({ branch: branch({ upstream: null }), capabilities }).label,
    ).toBe("Publish Branch");
    expect(getGitBranchPrimaryAction({ branch: branch(), capabilities, failed: true }).label).toBe(
      "Fetch now",
    );
  });

  it("keeps the right-click menu order with Autofetch as the sixth item", () => {
    const labels = buildGitBranchContextMenuModel({ branch: branch(), capabilities }).map(
      (item) => item.label,
    );

    expect(labels).toEqual([
      "Fetch now",
      "Pull",
      "Push",
      "Publish Branch",
      "Copy upstream",
      "Autofetch",
    ]);
  });

  it("disables publish and copy-upstream according to upstream presence", () => {
    const tracked = buildGitBranchContextMenuModel({ branch: branch(), capabilities });
    expect(find(tracked, "Publish Branch").disabled).toBe(true);
    expect(find(tracked, "Copy upstream").disabled).toBe(false);

    const untracked = buildGitBranchContextMenuModel({
      branch: branch({ upstream: null }),
      capabilities,
    });
    expect(find(untracked, "Publish Branch").disabled).toBe(false);
    expect(find(untracked, "Copy upstream").disabled).toBe(true);
  });
});

function find(model: ReturnType<typeof buildGitBranchContextMenuModel>, label: string) {
  const item = model.find((candidate) => candidate.label === label);
  if (!item) throw new Error(`missing ${label}`);
  return item;
}
