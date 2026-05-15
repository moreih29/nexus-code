/**
 * Scenario tests for Source Control file/group context-menu rules.
 */
import { describe, expect, it, mock } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  buildGitFileContextMenuItems,
  buildGitGroupContextMenuItems,
  revealInOSLabel,
} from "../../../../../../src/renderer/components/files/git/file-row/git-file-context-menu";
import { GitFileRow } from "../../../../../../src/renderer/components/files/git/file-row/git-file-row";
import { GitGroup } from "../../../../../../src/renderer/components/files/git/file-row/git-group";
import type { GitStatusEntry } from "../../../../../../src/shared/types/git";

const entry: GitStatusEntry = { relPath: "src/app.ts", xy: ".M", conflictType: null };

describe("Git file context menu rules", () => {
  it("applies group-specific hide rules and platform reveal labels", () => {
    const stagedLabels = labelsFor("staged");
    const untrackedLabels = labelsFor("untracked");
    const mergeLabels = labelsFor("merge");

    expect(stagedLabels).not.toContain("Discard");
    expect(untrackedLabels).not.toContain("Open Changes");
    expect(mergeLabels).toEqual([
      "Open Diff",
      "Open in External Editor",
      "Mark Resolved",
      "Discard",
    ]);
    expect(mergeLabels).not.toContain("Add to .gitignore");
    expect(revealInOSLabel("darwin")).toBe("Reveal in Finder");
    expect(revealInOSLabel("win32")).toBe("Reveal in Explorer");
    expect(revealInOSLabel("linux")).toBe("Open Containing Folder");
  });

  it("keeps Open Changes discoverable and lets copy actions write exact path values", () => {
    let banner = "";
    let clipboard = "";
    const actions = makeActions({
      openChanges: () => {
        banner = "Diff view 곧 추가 예정";
      },
      copyPath: () => {
        clipboard = "/repo/src/app.ts";
      },
      copyRelativePath: () => {
        clipboard = "src/app.ts";
      },
    });

    const items = buildGitFileContextMenuItems("working", actions);
    select(items, "Open Changes");
    expect(banner).toBe("Diff view 곧 추가 예정");

    select(items, "Copy Path");
    expect(clipboard).toBe("/repo/src/app.ts");
    select(items, "Copy Relative Path");
    expect(clipboard).toBe("src/app.ts");
  });

  it("renders conflict hover actions with path-specific mark-resolved aria label", () => {
    const html = renderToStaticMarkup(
      <GitFileRow
        groupKey="merge"
        entry={entry}
        onOpenDiff={() => {}}
        onDiscard={() => {}}
        onMarkResolved={() => {}}
        onOpenFile={() => {}}
        onRevealInOS={() => {}}
        onCopyPath={() => {}}
        onCopyRelativePath={() => {}}
        onAddToGitignore={() => {}}
      />,
    );

    expect(html).toContain('aria-label="Mark src/app.ts resolved"');
    expect(html).toContain('title="Open in External Editor"');
    expect(html).not.toContain("Stage changes");
  });
});

describe("Git group header actions", () => {
  it("renders only the accepted hover-icon actions for working, untracked, staged, and merge groups", () => {
    const working = renderGroup("working", "Working Changes");
    expect(working).toContain("Stage all working changes");
    expect(working).toContain("Discard all working changes");

    const untracked = renderGroup("untracked", "Untracked Changes");
    expect(untracked).toContain("Stage all untracked changes");
    expect(untracked).not.toContain("Discard all untracked changes");

    const staged = renderGroup("staged", "Staged Changes");
    expect(staged).toContain("Unstage all staged changes");
    expect(staged).not.toContain("Discard all staged changes");

    const merge = renderGroup("merge", "Merge Conflicts");
    expect(merge).toContain("Merge Conflicts group actions");
    expect(merge).not.toContain("Stage all merge conflicts");
    expect(merge).not.toContain("Discard all merge conflicts");
    expect(merge).not.toContain("Unstage all staged changes");
  });

  it("wires Stash Changes in Group for non-merge groups only", () => {
    const stashGroup = mock(() => {});
    const workingItems = buildGitGroupContextMenuItems("working", {
      stageAll: mock(() => {}),
      discardAll: mock(() => {}),
      stashGroup,
    });
    select(workingItems, "Stash Changes in Group");
    expect(stashGroup).toHaveBeenCalledTimes(1);

    const mergeItems = buildGitGroupContextMenuItems("merge", {
      stashGroup,
    });
    expect(mergeItems.some((item) => item.kind === "item" && item.label === "Abort Merge")).toBe(
      false,
    );
    const mergeStash = mergeItems.find(
      (item) => item.kind === "item" && item.label === "Stash Changes in Group",
    );
    expect(mergeStash?.kind).toBe("item");
    if (mergeStash?.kind === "item") expect(mergeStash.disabled).toBe(true);
  });
});

/** Returns visible menu item labels for one file group. */
function labelsFor(groupKey: "merge" | "staged" | "working" | "untracked"): string[] {
  return buildGitFileContextMenuItems(groupKey, makeActions())
    .filter((item) => item.kind === "item")
    .map((item) => item.label);
}

/** Selects one generated menu item by label. */
function select(items: ReturnType<typeof buildGitFileContextMenuItems>, label: string): void {
  const item = items.find((candidate) => candidate.kind === "item" && candidate.label === label);
  if (!item || item.kind !== "item") throw new Error(`missing menu item ${label}`);
  item.onSelect();
}

/** Creates default no-op file menu actions with optional overrides. */
function makeActions(overrides: Partial<Parameters<typeof buildGitFileContextMenuItems>[1]> = {}) {
  return {
    openFile: mock(() => {}),
    openChanges: mock(() => {}),
    markResolved: mock(() => {}),
    stage: mock(() => {}),
    unstage: mock(() => {}),
    discard: mock(() => {}),
    revealInOS: mock(() => {}),
    copyPath: mock(() => {}),
    copyRelativePath: mock(() => {}),
    addToGitignore: mock(() => {}),
    ...overrides,
  };
}

/** Renders one non-empty GitGroup to static markup for header action assertions. */
function renderGroup(groupKey: "merge" | "staged" | "working" | "untracked", label: string) {
  return renderToStaticMarkup(
    <GitGroup
      groupKey={groupKey}
      label={label}
      entries={[entry]}
      expanded={false}
      onToggle={() => {}}
      onStagePaths={() => {}}
      onUnstagePaths={() => {}}
      onDiscardPaths={() => {}}
      onMarkResolved={() => {}}
      onOpenDiff={() => {}}
      onOpenFile={() => {}}
      onRevealInOS={() => {}}
      onCopyPath={() => {}}
      onCopyRelativePath={() => {}}
      onAddToGitignore={() => {}}
      onAddPathsToGitignore={() => {}}
      onStashGroup={() => {}}
    />,
  );
}
