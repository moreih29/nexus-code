import { describe, expect, test } from "bun:test";
import type { ReactElement, ReactNode } from "react";

import {
  EMPTY_SEARCH_WORKSPACE_STATE,
  type SearchFileResultGroup,
  type SearchMatch,
  type SearchWorkspaceState,
} from "../stores/search-store";
import { SearchPanelView } from "./SearchPanel";

const match: SearchMatch = {
  id: "search-session:0",
  ordinal: 0,
  path: "src/app.ts",
  lineNumber: 12,
  column: 7,
  lineText: "const foo = 1;",
  submatches: [{ start: 6, end: 9, match: "foo" }],
};

const group: SearchFileResultGroup = {
  path: "src/app.ts",
  matches: [match],
};

function state(overrides: Partial<SearchWorkspaceState> = {}): SearchWorkspaceState {
  return {
    ...EMPTY_SEARCH_WORKSPACE_STATE,
    options: { ...EMPTY_SEARCH_WORKSPACE_STATE.options },
    ...overrides,
  };
}

describe("SearchPanelView", () => {
  test("renders empty state when no workspace is active", () => {
    const tree = SearchPanelView({
      workspaceState: EMPTY_SEARCH_WORKSPACE_STATE,
      fileGroups: [],
      canSearch: false,
    });

    expect(findText(tree, "No workspace selected")).toBe(true);
    expect(findText(tree, "Open a workspace to search across project files.")).toBe(true);
  });

  test("renders search controls, toggles, advanced disclosure, replace mode, and history", () => {
    const tree = SearchPanelView({
      activeWorkspaceName: "Alpha",
      canSearch: true,
      fileGroups: [],
      workspaceState: state({
        query: "foo",
        replaceText: "bar",
        replaceMode: true,
        advancedOpen: true,
        history: ["foo", "bar"],
        options: {
          ...EMPTY_SEARCH_WORKSPACE_STATE.options,
          caseSensitive: true,
          includeText: "src/**",
          excludeText: "node_modules/**",
        },
      }),
    });

    expect(findText(tree, "Search")).toBe(true);
    expect(findText(tree, "Alpha")).toBe(true);
    expect(findInputByLabel(tree, "Search query")?.props.value).toBe("foo");
    expect(findInputByLabel(tree, "Replace text")?.props.value).toBe("bar");
    expect(findInputByLabel(tree, "Include files")?.props.value).toBe("src/**");
    expect(findInputByLabel(tree, "Exclude files")?.props.value).toBe("node_modules/**");
    expect(findElementByPredicate(tree, (element) => element.props?.["data-search-advanced-open"] === "true")).toBeDefined();
    expect(findElementByPredicate(tree, (element) => element.props?.["data-search-replace-mode"] === "true")).toBeDefined();
    expect(findElementByPredicate(tree, (element) => element.props?.["aria-label"] === "Search history")).toBeDefined();
  });

  test("renders grouped results and invokes open callback when a result is clicked", () => {
    const opened: SearchMatch[] = [];
    const tree = SearchPanelView({
      activeWorkspaceName: "Alpha",
      canSearch: true,
      fileGroups: [group],
      workspaceState: state({
        status: "completed",
        matchCount: 1,
        fileCount: 1,
        activeMatch: {
          matchId: match.id,
          path: match.path,
          lineNumber: match.lineNumber,
          column: match.column,
        },
      }),
      onOpenResult(nextMatch) {
        opened.push(nextMatch);
      },
    });

    expect(findText(tree, "src/app.ts")).toBe(true);
    expect(findText(tree, "12:7")).toBe(true);
    expect(findText(tree, "foo")).toBe(true);

    const resultButton = findElementByPredicate(
      tree,
      (element) => element.props?.["data-search-result-active"] === "true",
    );
    expect(resultButton).toBeDefined();
    resultButton?.props.onClick();
    expect(opened).toEqual([match]);
  });

  test("shows the 10k truncation indicator", () => {
    const tree = SearchPanelView({
      activeWorkspaceName: "Alpha",
      canSearch: true,
      fileGroups: [group],
      workspaceState: state({
        status: "completed",
        matchCount: 10_000,
        fileCount: 1,
        truncated: true,
      }),
    });

    expect(findText(tree, "Showing first 10,000 results")).toBe(true);
  });
});

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
