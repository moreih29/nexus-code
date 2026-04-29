import { describe, expect, test } from "bun:test";
import type { ReactElement, ReactNode } from "react";

import type { WorkspaceId } from "../../../../shared/src/contracts/workspace/workspace";
import type { WorkspaceSidebarState } from "../../../../shared/src/contracts/workspace/workspace-shell";
import {
  scrollWorkspaceTabIntoView,
  WorkspaceStripView,
  workspaceTabId,
  type WorkspaceStripViewProps,
} from "./WorkspaceStrip";

const baseWorkspaces = [
  {
    id: "ws_alpha" as WorkspaceId,
    absolutePath: "/tmp/alpha",
    displayName: "Alpha",
  },
  {
    id: "ws_beta" as WorkspaceId,
    absolutePath: "/tmp/beta",
    displayName: "Beta",
  },
  {
    id: "ws_korean" as WorkspaceId,
    absolutePath: "/tmp/한글 프로젝트/소스",
    displayName: "한글프로젝트",
  },
];

describe("WorkspaceStripView", () => {
  test("renders an empty state, vertical tablist, and bottom open-folder action with Cmd+O", () => {
    let openCount = 0;
    const tree = renderStrip({
      sidebarState: {
        openWorkspaces: [],
        activeWorkspaceId: null,
      },
      onOpenFolder() {
        openCount += 1;
      },
    });

    const tablist = findElementByPredicate(tree, (element) => element.props?.role === "tablist");
    expect(tablist?.props["aria-orientation"]).toBe("vertical");
    expect(findText(tree, "No workspace open")).toBe(true);
    expect(findText(tree, "Open Folder")).toBe(true);
    expect(findText(tree, "⌘O")).toBe(true);

    const openButton = findElementByPredicate(
      tree,
      (element) => element.props?.["data-action"] === "open-folder",
    );
    expect(openButton?.props.className).toContain("h-8");
    openButton?.props.onClick();
    expect(openCount).toBe(1);
  });

  test("keeps the header visually light and muted", () => {
    const tree = renderStrip({
      sidebarState: {
        openWorkspaces: baseWorkspaces,
        activeWorkspaceId: "ws_beta" as WorkspaceId,
      },
    });

    const heading = findElementByPredicate(
      tree,
      (element) => element.type === "h2" && findText(element, "Workspaces"),
    );
    expect(heading?.props.className).toContain("text-[10px]");
    expect(heading?.props.className).toContain("font-medium");
    expect(heading?.props.className).toContain("uppercase");
    expect(heading?.props.className).toContain("tracking-[0.18em]");
    expect(heading?.props.className).toContain("text-muted-foreground");
    expect(heading?.props.className).not.toContain("font-semibold");

    const count = findElementByPredicate(
      tree,
      (element) => element.type === "p" && findText(element, "3 open"),
    );
    expect(count?.props.className).toContain("text-[10px]");
    expect(count?.props.className).toContain("text-muted-foreground/70");
  });

  test("renders a one-row active workspace with ownership, tooltip, status dot, and hover close", () => {
    const activated: WorkspaceId[] = [];
    const closed: WorkspaceId[] = [];
    const tree = renderStrip({
      sidebarState: {
        openWorkspaces: [baseWorkspaces[2]!],
        activeWorkspaceId: "ws_korean" as WorkspaceId,
      },
      badgeByWorkspaceId: {
        ws_korean: {
          workspaceId: "ws_korean" as WorkspaceId,
          adapterName: "claude-code",
          sessionId: "sess_001",
          state: "running",
          timestamp: "2026-04-28T00:00:00.000Z",
        },
      },
      onActivateWorkspace(workspaceId) {
        activated.push(workspaceId);
      },
      onCloseWorkspace(workspaceId) {
        closed.push(workspaceId);
      },
    });

    const activeRow = findElementByPredicate(
      tree,
      (element) => element.props?.["data-workspace-row"] === "true",
    );
    expect(activeRow?.props.className).toContain("h-8");
    expect(activeRow?.props.className).toContain("bg-accent");
    expect(activeRow?.props.className).toContain("ring-primary/30");

    const activeTab = findElementByPredicate(tree, (element) => element.props?.role === "tab");
    expect(activeTab?.props.id).toBe(workspaceTabId("ws_korean" as WorkspaceId));
    expect(activeTab?.props["aria-selected"]).toBe(true);
    expect(activeTab?.props["aria-describedby"]).toBe(`${workspaceTabId("ws_korean" as WorkspaceId)}-path`);
    expect(activeTab?.props.title).toBe("/tmp/한글 프로젝트/소스");
    expect(String(activeTab?.props.className)).toContain("min-w-0");
    activeTab?.props.onClick();
    expect(activated).toEqual(["ws_korean"]);

    expect(findText(tree, "한글프로젝트")).toBe(true);
    expect(findText(tree, "/tmp/한글 프로젝트/소스")).toBe(true);
    expect(findElementByPredicate(tree, (element) => element.props?.["data-workspace-icon"] === "folder-open")).toBeDefined();
    expect(findElementByPredicate(tree, (element) => element.props?.["data-harness-badge-state"] === "running")).toBeDefined();

    const closeButton = findElementByPredicate(
      tree,
      (element) => element.props?.["data-action"] === "close-workspace",
    );
    expect(closeButton?.props.className).toContain("opacity-0");
    expect(closeButton?.props.className).toContain("group-hover:opacity-100");
    closeButton?.props.onClick();
    expect(closed).toEqual(["ws_korean"]);
  });

  test("renders three workspace shortcut labels and inactive folder icons", () => {
    const tree = renderStrip({
      sidebarState: {
        openWorkspaces: baseWorkspaces,
        activeWorkspaceId: "ws_beta" as WorkspaceId,
      },
    });

    const tabs = findElementsByPredicate(tree, (element) => element.props?.role === "tab");
    expect(tabs).toHaveLength(3);
    expect(tabs.map((tab) => tab.props["aria-selected"])).toEqual([false, true, false]);
    expect(findElementsByPredicate(tree, (element) => element.props?.["data-workspace-icon"] === "folder")).toHaveLength(2);
    expect(findElementByPredicate(tree, (element) => element.props?.["data-workspace-shortcut"] === "⌘1")).toBeDefined();
    expect(findElementByPredicate(tree, (element) => element.props?.["data-workspace-shortcut"] === "⌘2")).toBeDefined();
    expect(findElementByPredicate(tree, (element) => element.props?.["data-workspace-shortcut"] === "⌘3")).toBeDefined();
  });

  test("keeps ten workspaces inside a self-scroll area and scrolls active rows by nearest block", () => {
    const tenWorkspaces = Array.from({ length: 10 }, (_, index) => ({
      id: `ws_${index + 1}` as WorkspaceId,
      absolutePath: `/tmp/workspace-${index + 1}`,
      displayName: `Workspace ${index + 1}`,
    }));
    const tree = renderStrip({
      sidebarState: {
        openWorkspaces: tenWorkspaces,
        activeWorkspaceId: "ws_10" as WorkspaceId,
      },
    });

    expect(findElementsByPredicate(tree, (element) => element.props?.role === "tab")).toHaveLength(10);
    const scrollArea = findElementByPredicate(
      tree,
      (element) => element.props?.["data-workspace-strip-scroll-area"] === "true",
    );
    expect(scrollArea?.props.className).toContain("h-full");

    let observedOptions: boolean | ScrollIntoViewOptions | undefined;
    scrollWorkspaceTabIntoView({
      scrollIntoView(options?: boolean | ScrollIntoViewOptions) {
        observedOptions = options;
      },
    });
    expect(observedOptions).toEqual({ block: "nearest" });
  });
});

function renderStrip(
  props: Partial<WorkspaceStripViewProps> & { sidebarState: WorkspaceSidebarState },
): ReactElement {
  return WorkspaceStripView({
    badgeByWorkspaceId: {},
    onActivateWorkspace() {},
    onCloseWorkspace() {},
    onOpenFolder() {},
    ...props,
  });
}

function findElementByPredicate(
  node: ReactNode,
  predicate: (element: ReactElement) => boolean,
): ReactElement | undefined {
  return findElementsByPredicate(node, predicate)[0];
}

function findElementsByPredicate(
  node: ReactNode,
  predicate: (element: ReactElement) => boolean,
): ReactElement[] {
  if (isReactElement(node)) {
    const matches = predicate(node) ? [node] : [];
    if (typeof node.type === "function") {
      return [...matches, ...findElementsByPredicate(node.type(node.props), predicate)];
    }

    return [
      ...matches,
      ...findElementsByPredicate(node.props.children, predicate),
    ];
  }

  if (Array.isArray(node)) {
    return node.flatMap((child) => findElementsByPredicate(child, predicate));
  }

  return [];
}

function findText(node: ReactNode, text: string): boolean {
  if (typeof node === "string") {
    return node === text;
  }

  if (isReactElement(node)) {
    if (typeof node.type === "function") {
      return findText(node.type(node.props), text);
    }

    return findText(node.props.children, text);
  }

  if (Array.isArray(node)) {
    return node.some((child) => findText(child, text));
  }

  return false;
}

function isReactElement(node: ReactNode): node is ReactElement {
  return typeof node === "object" && node !== null && "props" in node;
}
