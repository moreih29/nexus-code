import { describe, expect, test } from "bun:test";
import type { ReactElement, ReactNode } from "react";

import { DEFAULT_BOTTOM_PANEL_VIEWS } from "../../services/bottom-panel-service";
import { BottomPanelPartView } from "./BottomPanelPart";

describe("BottomPanelPartView", () => {
  test("exposes Terminal, Output, and Problems views with Terminal selected by default", () => {
    const selected: string[] = [];
    const tree = BottomPanelPartView({
      views: DEFAULT_BOTTOM_PANEL_VIEWS,
      activeViewId: "terminal",
      position: "bottom",
      expanded: true,
      onActiveViewChange: (viewId) => selected.push(viewId),
      viewPanels: {
        terminal: <div data-test-panel="terminal">Terminal panel</div>,
        output: <div data-test-panel="output">Output panel</div>,
        problems: <div data-test-panel="problems">Problems panel</div>,
      },
    });

    const panel = findElementByPredicate(tree, (element) => element.props?.["data-component"] === "bottom-panel");
    const header = findElementByPredicate(tree, (element) => element.props?.["data-bottom-panel-header"] === "true");
    const buttons = findElementsByPredicate(
      tree,
      (element) => element.props?.["data-action"] === "bottom-panel-select-view" && element.props?.["data-slot"] === "button",
    );
    const terminalView = findElementByPredicate(tree, (element) => element.props?.["data-bottom-panel-view-panel"] === "terminal");
    const outputButton = buttons.find((element) => element.props?.["data-bottom-panel-view"] === "output");

    expect(panel?.props["data-bottom-panel-active-view"]).toBe("terminal");
    expect(panel?.props["data-bottom-panel-position"]).toBe("bottom");
    expect(panel?.props["data-active"]).toBe("true");
    expect(String(header?.props.className)).toContain("bg-card");
    expect(buttons.map((element) => element.props["data-bottom-panel-view"])).toEqual(["terminal", "output", "problems"]);
    expect(terminalView?.props["data-visible"]).toBe("true");
    expect(findElementByPredicate(tree, (element) => element.props?.["data-test-panel"] === "output")).toBeDefined();

    outputButton?.props.onClick();
    expect(selected).toEqual(["output"]);
  });

  test("carries dock position hooks for left/right/top/bottom", () => {
    for (const position of ["left", "right", "top", "bottom"] as const) {
      const tree = BottomPanelPartView({
        views: DEFAULT_BOTTOM_PANEL_VIEWS,
        activeViewId: "problems",
        position,
        expanded: true,
        viewPanels: {
          terminal: <div />,
          output: <div />,
          problems: <div />,
        },
      });
      const panel = findElementByPredicate(tree, (element) => element.props?.["data-component"] === "bottom-panel");
      const dockZone = findElementByPredicate(tree, (element) => element.props?.["data-bottom-panel-dock-zone"] === "true");
      const problemsView = findElementByPredicate(tree, (element) => element.props?.["data-bottom-panel-view-panel"] === "problems");

      expect(panel?.props["data-bottom-panel-position"]).toBe(position);
      expect(dockZone?.props["data-bottom-panel-dock-positions"]).toBe("left right top bottom");
      expect(problemsView?.props["data-visible"]).toBe("true");
    }
  });

  test("uses inactive header background without pane rings", () => {
    const tree = BottomPanelPartView({
      views: DEFAULT_BOTTOM_PANEL_VIEWS,
      active: false,
      activeViewId: "terminal",
      position: "bottom",
      expanded: true,
      viewPanels: {
        terminal: <div />,
        output: <div />,
        problems: <div />,
      },
    });

    const panel = findElementByPredicate(tree, (element) => element.props?.["data-component"] === "bottom-panel");
    const header = findElementByPredicate(tree, (element) => element.props?.["data-bottom-panel-header"] === "true");

    expect(panel?.props["data-active"]).toBe("false");
    expect(String(panel?.props.className)).not.toContain("ring-1 ring-inset");
    expect(String(header?.props.className)).toContain("bg-card/60");
  });
});

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
      return matches.concat(findElementsByPredicate(node.type(node.props), predicate));
    }

    return matches.concat(findElementsByPredicate(node.props.children, predicate));
  }

  if (Array.isArray(node)) {
    return node.flatMap((child) => findElementsByPredicate(child, predicate));
  }

  return [];
}

function isReactElement(node: ReactNode): node is ReactElement {
  return typeof node === "object" && node !== null && "props" in node;
}
