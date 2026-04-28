import { describe, expect, test } from "bun:test";
import type { ReactElement, ReactNode } from "react";

import type { GitStatusSummary } from "../../../../shared/src/contracts/generated/git-lifecycle";
import {
  EMPTY_SOURCE_CONTROL_WORKSPACE_STATE,
  getSourceControlFileGroups,
  type SourceControlWorkspaceState,
} from "../stores/source-control-store";
import { SourceControlPanelView } from "./SourceControlPanel";

const summary: GitStatusSummary = {
  branch: "main",
  upstream: "origin/main",
  ahead: 2,
  behind: 1,
  files: [
    entry("src/changed.ts", " M", "modified"),
    entry("src/staged.ts", "A ", "added"),
    entry("src/conflict.ts", "UU", "conflicted"),
  ],
};

function state(overrides: Partial<SourceControlWorkspaceState> = {}): SourceControlWorkspaceState {
  return {
    ...EMPTY_SOURCE_CONTROL_WORKSPACE_STATE,
    diff: { ...EMPTY_SOURCE_CONTROL_WORKSPACE_STATE.diff },
    ...overrides,
  };
}

describe("SourceControlPanelView", () => {
  test("renders empty state without an active workspace", () => {
    const tree = SourceControlPanelView({
      workspaceState: EMPTY_SOURCE_CONTROL_WORKSPACE_STATE,
      fileGroups: [],
      canUseSourceControl: false,
      branchDropdownOpen: false,
      branchFilter: "",
      newBranchName: "",
    });

    expect(findText(tree, "No workspace selected")).toBe(true);
    expect(findText(tree, "Open a workspace to review changes, branches, and commits.")).toBe(true);
  });

  test("renders branch dropdown, grouped files, commit controls, and inline actions", () => {
    const stagedPaths: string[][] = [];
    const unstagedPaths: string[][] = [];
    const discardedPaths: string[][] = [];
    const diffs: Array<{ path: string; staged?: boolean }> = [];
    const commits: boolean[] = [];
    const checkouts: string[] = [];
    const deletedBranches: string[] = [];
    let created = 0;

    const tree = SourceControlPanelView({
      activeWorkspaceName: "Alpha",
      branchDropdownOpen: true,
      branchFilter: "fea",
      fileGroups: getSourceControlFileGroups(summary),
      newBranchName: "feature/new",
      workspaceState: state({
        status: "ready",
        summary,
        branches: [
          { name: "main", current: true, upstream: "origin/main", headOid: "abc" },
          { name: "feature/demo", current: false, upstream: null, headOid: "def" },
        ],
        commitMessage: "feat: source control\n\nbody line",
      }),
      canUseSourceControl: true,
      onCheckoutBranch(ref) {
        checkouts.push(ref);
      },
      onCommit(amend) {
        commits.push(amend);
      },
      onCreateBranch() {
        created += 1;
      },
      onDeleteBranch(name) {
        deletedBranches.push(name);
      },
      onDiscardPaths(paths) {
        discardedPaths.push(paths);
      },
      onStagePaths(paths) {
        stagedPaths.push(paths);
      },
      onUnstagePaths(paths) {
        unstagedPaths.push(paths);
      },
      onViewDiff(path, staged) {
        diffs.push({ path, staged });
      },
    });

    expect(findText(tree, "Source Control")).toBe(true);
    expect(findText(tree, "main")).toBe(true);
    expect(findText(tree, "↑2 ↓1")).toBe(true);
    expect(findText(tree, "Changes")).toBe(true);
    expect(findText(tree, "Staged Changes")).toBe(true);
    expect(findText(tree, "Conflicts")).toBe(true);
    expect(findText(tree, "Subject 20/50 · Body 9/72")).toBe(true);
    expect(findInputByLabel(tree, "Commit message")?.props.value).toBe("feat: source control\n\nbody line");
    expect(findElementByPredicate(tree, (element) => element.props?.["data-source-control-branch-dropdown"] === "true")).toBeDefined();
    expect(findInputByLabel(tree, "Filter branches")?.props.value).toBe("fea");
    expect(findInputByLabel(tree, "Create branch name")?.props.value).toBe("feature/new");

    findElementByPredicate(tree, (element) => element.props?.["data-action"] === "source-control-create-branch")?.props.onClick();
    findElementByPredicate(tree, (element) => element.props?.["data-action"] === "source-control-delete-branch")?.props.onClick();
    findElementByPredicate(tree, (element) => element.props?.["data-action"] === "source-control-checkout-branch" && element.props?.["data-branch-current"] === "false")?.props.onClick();
    findElementByPredicate(tree, (element) => element.props?.["data-action"] === "source-control-stage-file")?.props.onClick();
    findElementByPredicate(tree, (element) => element.props?.["data-action"] === "source-control-unstage-file")?.props.onClick();
    findElementByPredicate(tree, (element) => element.props?.["data-action"] === "source-control-discard-file")?.props.onClick();
    findElementByPredicate(tree, (element) => element.props?.["data-action"] === "source-control-view-diff")?.props.onClick();
    findElementByPredicate(tree, (element) => element.props?.["data-action"] === "source-control-commit")?.props.onClick();

    const commitInput = findInputByLabel(tree, "Commit message");
    let prevented = false;
    commitInput?.props.onKeyDown({
      key: "Enter",
      metaKey: true,
      ctrlKey: false,
      shiftKey: true,
      nativeEvent: { key: "Enter" },
      preventDefault() {
        prevented = true;
      },
    });

    expect(created).toBe(1);
    expect(deletedBranches).toEqual(["feature/demo"]);
    expect(checkouts).toEqual(["feature/demo"]);
    expect(stagedPaths).toEqual([["src/changed.ts"]]);
    expect(unstagedPaths).toEqual([["src/staged.ts"]]);
    expect(discardedPaths).toEqual([["src/changed.ts"]]);
    expect(diffs).toEqual([{ path: "src/changed.ts", staged: false }]);
    expect(commits).toEqual([false, true]);
    expect(prevented).toBe(true);
  });

  test("renders dirty checkout warning with disabled stash action", () => {
    let canceled = 0;
    let discarded = 0;
    const tree = SourceControlPanelView({
      activeWorkspaceName: "Alpha",
      branchDropdownOpen: false,
      branchFilter: "",
      fileGroups: getSourceControlFileGroups(summary),
      newBranchName: "",
      workspaceState: state({
        status: "ready",
        summary,
        pendingCheckout: { ref: "feature/demo", dirtyFileCount: 3 },
      }),
      canUseSourceControl: true,
      onClearPendingCheckout() {
        canceled += 1;
      },
      onConfirmDiscardCheckout() {
        discarded += 1;
      },
    });

    expect(findText(tree, "Checkout with local changes?")).toBe(true);
    expect(findText(tree, "Stash")).toBe(true);
    const stashButton = findElementByPredicate(tree, (element) => element.props?.["data-action"] === "source-control-stash-checkout");
    expect(stashButton?.props.disabled).toBe(true);

    findElementByPredicate(tree, (element) => element.props?.["data-action"] === "source-control-discard-checkout")?.props.onClick();
    findElementByPredicate(tree, (element) => element.props?.["data-action"] === "source-control-cancel-checkout")?.props.onClick();

    expect(discarded).toBe(1);
    expect(canceled).toBe(1);
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

function findInputByLabel(node: ReactNode, label: string): ReactElement | undefined {
  return findElementByPredicate(node, (element) => element.props?.["aria-label"] === label);
}

function findElementByPredicate(
  node: ReactNode,
  predicate: (element: ReactElement) => boolean,
): ReactElement | undefined {
  let result: ReactElement | undefined;
  visitElements(node, (element) => {
    if (!result && predicate(element)) {
      result = element;
    }
  });
  return result;
}

function visitElements(node: ReactNode, visit: (element: ReactElement) => void): void {
  if (isReactElement(node)) {
    if (typeof node.type === "function") {
      visitElements(node.type(node.props), visit);
      return;
    }
    visit(node);
    visitElements(node.props.children, visit);
    return;
  }

  if (Array.isArray(node)) {
    for (const child of node) {
      visitElements(child, visit);
    }
  }
}

function findText(node: ReactNode, text: string): boolean {
  return textContent(node).includes(text);
}

function isReactElement(node: ReactNode): node is ReactElement {
  return typeof node === "object" && node !== null && "props" in node;
}

function textContent(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }

  if (isReactElement(node)) {
    if (typeof node.type === "function") {
      return textContent(node.type(node.props));
    }
    const propText = [node.props.title, node.props.description]
      .filter((value): value is string | number => typeof value === "string" || typeof value === "number")
      .join(" ");
    return `${propText} ${textContent(node.props.children)}`;
  }

  if (Array.isArray(node)) {
    return node.map((child) => textContent(child)).join("");
  }

  return "";
}
