import { describe, expect, test } from "bun:test";
import type { ReactElement, ReactNode } from "react";

import type { WorkspaceSidebarState } from "../../../../shared/src/contracts/workspace-shell";
import { WorkspaceSidebar } from "./WorkspaceSidebar";

const sidebarState: WorkspaceSidebarState = {
  openWorkspaces: [
    {
      id: "ws_alpha",
      absolutePath: "/tmp/alpha",
      displayName: "Alpha",
    },
    {
      id: "ws_beta",
      absolutePath: "/tmp/beta",
      displayName: "Beta",
    },
  ],
  activeWorkspaceId: "ws_alpha",
};

describe("WorkspaceSidebar harness badges", () => {
  test("renders stable workspace header and row controls for the resizable left panel", () => {
    const tree = WorkspaceSidebar({
      sidebarState,
      badgeByWorkspaceId: {},
      onOpenFolder: async () => {},
      onActivateWorkspace: async () => {},
      onCloseWorkspace: async () => {},
    });

    expect(findText(tree, "Workspaces")).toBe(true);
    expect(findText(tree, "2 open")).toBe(true);
    expect(
      findElementByPredicate(
        tree,
        (element) =>
          element.props?.["data-action"] === "open-folder" &&
          String(element.props?.className).includes("shrink-0"),
      ),
    ).toBeDefined();
    expect(
      findElementByPredicate(
        tree,
        (element) =>
          element.props?.["data-action"] === "activate-workspace" &&
          element.props?.["data-workspace-id"] === "ws_alpha" &&
          String(element.props?.className).includes("min-w-0"),
      ),
    ).toBeDefined();
    expect(
      findElementByPredicate(
        tree,
        (element) =>
          element.props?.["data-action"] === "close-workspace" &&
          element.props?.["data-workspace-id"] === "ws_alpha" &&
          String(element.props?.className).includes("shrink-0"),
      ),
    ).toBeDefined();
  });

  test("renders running, awaiting approval, and error badge states with aria labels", () => {
    for (const [state, expectedLabel] of [
      ["running", "도구 실행 중"],
      ["awaiting-approval", "터미널에서 승인 대기 중"],
      ["error", "하네스 오류"],
    ] as const) {
      const tree = WorkspaceSidebar({
        sidebarState,
        badgeByWorkspaceId: {
          ws_alpha: {
            workspaceId: "ws_alpha",
            state,
            sessionId: "sess_001",
            adapterName: "claude-code",
            timestamp: "2026-04-26T05:15:00.000Z",
          },
        },
        onOpenFolder: async () => {},
        onActivateWorkspace: async () => {},
        onCloseWorkspace: async () => {},
      });

      const badge = findElementByProp(tree, "data-harness-badge-state", state);
      expect(badge).toBeDefined();
      expect(findText(tree, expectedLabel)).toBe(true);
      expect(
        findElementByPredicate(
          tree,
          (element) =>
            element.props?.["data-action"] === "activate-workspace" &&
            element.props?.["data-workspace-id"] === "ws_alpha" &&
            element.props?.["aria-label"] === `Alpha: ${expectedLabel}`,
        ),
      ).toBeDefined();
    }
  });

  test("completed state is represented by no visible badge", () => {
    const tree = WorkspaceSidebar({
      sidebarState,
      badgeByWorkspaceId: {},
      onOpenFolder: async () => {},
      onActivateWorkspace: async () => {},
      onCloseWorkspace: async () => {},
    });

    expect(findElementByProp(tree, "data-harness-badge-state", "running")).toBeUndefined();
    expect(findElementByProp(tree, "data-harness-badge-state", "awaiting-approval")).toBeUndefined();
    expect(findElementByProp(tree, "data-harness-badge-state", "error")).toBeUndefined();
  });
});

function findElementByProp(
  node: ReactNode,
  propName: string,
  propValue: unknown,
): ReactElement | undefined {
  return findElementByPredicate(node, (element) => element.props?.[propName] === propValue);
}

function findElementByPredicate(
  node: ReactNode,
  predicate: (element: ReactElement) => boolean,
): ReactElement | undefined {
  if (isReactElement(node)) {
    if (predicate(node)) {
      return node;
    }

    return findElementByPredicate(node.props.children, predicate);
  }

  if (Array.isArray(node)) {
    for (const child of node) {
      const match = findElementByPredicate(child, predicate);
      if (match) {
        return match;
      }
    }
  }

  return undefined;
}

function findText(node: ReactNode, text: string): boolean {
  if (typeof node === "string") {
    return node === text;
  }

  if (isReactElement(node)) {
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
