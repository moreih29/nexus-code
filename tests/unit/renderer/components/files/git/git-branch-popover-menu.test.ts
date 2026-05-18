/**
 * Scenario tests for BranchChip glyphs and branch action menus.
 */
import { describe, expect, it, mock } from "bun:test";
import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  BranchChip,
  branchChipGlyph,
} from "../../../../../../src/renderer/components/files/git/branch/chip";
import { GitBranchBar } from "../../../../../../src/renderer/components/files/git/branch/branch-bar";
import {
  buildGitBranchContextMenuModel,
  GitBranchPopoverContent,
  getGitBranchPrimaryAction,
} from "../../../../../../src/renderer/components/files/git/branch/branch-popover";
import type { BranchInfo, RepoCapabilities } from "../../../../../../src/shared/git/types";

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
  it("renders only ahead, behind, and diverged upstream delta states", () => {
    expect(branchChipGlyph({ branch: branch({ ahead: 2 }) })).toBe("↑2");
    expect(branchChipGlyph({ branch: branch({ behind: 3 }) })).toBe("↓3");
    expect(branchChipGlyph({ branch: branch({ ahead: 2, behind: 3 }) })).toBe("↑2↓3");
    expect(branchChipGlyph({ branch: branch({ upstream: null }) })).toBeNull();
    expect(branchChipGlyph({ branch: branch() })).toBeNull();
    expect(branchChipGlyph({ branch: null })).toBeNull();
  });
});

describe("BranchChip rendering", () => {
  it("keeps the trigger and footer bar at the unified h-9 chrome height", () => {
    const chipHtml = renderBranchChip(branch());
    const barHtml = renderBranchBar();

    expect(chipHtml).toContain("h-9");
    expect(chipHtml).not.toContain("h-7");
    expect(barHtml).toContain('class="flex h-9');
    expect(barHtml).not.toContain('class="flex h-7');
  });

  it("renders the upstream delta glyph matrix on the chip", () => {
    const cases = [
      { current: branch({ ahead: 2 }), glyph: "↑2" },
      { current: branch({ behind: 3 }), glyph: "↓3" },
      { current: branch({ ahead: 2, behind: 3 }), glyph: "↑2↓3" },
    ];

    for (const { current, glyph } of cases) {
      const html = renderBranchChip(current);

      expect(html).toContain(`>${glyph}<`);
      expect(html).not.toContain(">local<");
    }
  });

  it("keeps a synced upstream branch as a branch-name trigger without a chip", () => {
    const html = renderBranchChip(branch());

    expect(html).toContain("main");
    expect(html).not.toContain("↑");
    expect(html).not.toContain("↓");
    expect(html).not.toContain("local");
  });

  it("renders no upstream as a dimmed local suffix instead of a chip", () => {
    const html = renderBranchChip(branch({ upstream: null }));

    expect(html).toContain(">local<");
    expect(html).not.toContain("⊘");
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

describe("GitBranchPopover content status", () => {
  it("keeps no-upstream guidance and publish CTA in the popover", () => {
    const html = renderPopoverContent({}, branch({ upstream: null }));

    expect(html).toContain("No upstream configured");
    expect(html).toContain("Publish Branch");
  });

  it("renders fetching in the popover status area", () => {
    const html = renderPopoverContent({ autofetchFetching: true });

    expect(html).toContain('role="status"');
    expect(html).toContain("animate-spin");
    expect(html).toContain("Fetching…");
    expect(html).not.toContain("Retry");
  });

  it("renders failed fetch text and retry in the popover status area", () => {
    const html = renderPopoverContent({ autofetchFailed: true });

    expect(html).toContain('role="alert"');
    expect(html).toContain("Fetch failed");
    expect(html).toContain("Retry");
  });

  it("wires the failed fetch Retry action to the retry callback", () => {
    const retry = mock(() => {});
    const tree = createElement(GitBranchPopoverContent, {
      branch: branch(),
      primaryAction: getGitBranchPrimaryAction({ branch: branch(), capabilities, failed: true }),
      autofetchFailed: true,
      onPrimary: () => {},
      onRetryFetch: retry,
    });
    const button = findButtonByText(tree, "Retry");

    if (!button) throw new Error("missing Retry button");
    button.props.onClick?.();

    expect(retry).toHaveBeenCalledTimes(1);
  });
});

function find(model: ReturnType<typeof buildGitBranchContextMenuModel>, label: string) {
  const item = model.find((candidate) => candidate.label === label);
  if (!item) throw new Error(`missing ${label}`);
  return item;
}

/** Renders a BranchChip to static markup for chip text/glyph assertions. */
function renderBranchChip(current: BranchInfo) {
  return renderToStaticMarkup(
    createElement(BranchChip, {
      branch: current,
      onClick: () => {},
      onContextMenu: () => {},
    }),
  );
}

/** Renders the footer bar to assert that it does not clip the BranchChip target. */
function renderBranchBar() {
  return renderToStaticMarkup(
    createElement(GitBranchBar, {
      workspaceId: "workspace-1",
      branch: branch(),
      capabilities,
      autofetchIntervalMin: 0,
      onSync: () => {},
      onFetch: () => {},
      onPull: () => {},
      onPush: () => {},
      onPublish: () => {},
      onSetAutofetchInterval: () => {},
      onSwitchBranch: () => {},
      onCreateFromRef: () => {},
    }),
  );
}

/** Renders popover content with a configurable branch and fetch status. */
function renderPopoverContent(
  overrides: Partial<
    Pick<Parameters<typeof GitBranchPopoverContent>[0], "autofetchFetching" | "autofetchFailed">
  >,
  current: BranchInfo = branch(),
) {
  return renderToStaticMarkup(
    createElement(GitBranchPopoverContent, {
      branch: current,
      primaryAction: getGitBranchPrimaryAction({ branch: current, capabilities }),
      onPrimary: () => {},
      onRetryFetch: () => {},
      ...overrides,
    }),
  );
}

/** Finds a rendered host button by text while resolving hook-free function components. */
function findButtonByText(
  node: ReactNode,
  text: string,
): ReactElement<{ children?: ReactNode; onClick?: () => void }> | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const match = findButtonByText(child, text);
      if (match) return match;
    }
    return null;
  }
  if (!isValidElement(node)) return null;

  if (typeof node.type === "function") {
    return findButtonByText(node.type(node.props), text);
  }
  if (node.type === "button" && textContent(node.props.children) === text) {
    return node as ReactElement<{ children?: ReactNode; onClick?: () => void }>;
  }
  return findButtonByText(node.props.children, text);
}

/** Extracts plain text from the small static React trees in this test file. */
function textContent(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textContent).join("");
  if (!isValidElement(node)) return "";
  return textContent(node.props.children);
}
