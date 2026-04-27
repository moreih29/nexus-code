import { describe, expect, test } from "bun:test";
import type { ReactElement, ReactNode } from "react";

import { CenterWorkbenchView } from "./CenterWorkbench";

describe("CenterWorkbenchView", () => {
  test("keeps terminal panel mounted while editor mode is visible", () => {
    const tree = CenterWorkbenchView({
      mode: "editor",
      onModeChange() {},
      editorPane: <div data-test-pane="editor">Editor pane</div>,
      terminalPane: <div data-test-pane="terminal">Terminal pane</div>,
    });

    expect(findElementByPredicate(tree, (element) => element.props?.["data-test-pane"] === "editor")).toBeDefined();
    expect(findElementByPredicate(tree, (element) => element.props?.["data-test-pane"] === "terminal")).toBeDefined();
    expect(findElementByPredicate(tree, (element) => element.props?.["data-center-mode-panel"] === "editor")?.props["data-visible"]).toBe("true");
    expect(findElementByPredicate(tree, (element) => element.props?.["data-center-mode-panel"] === "terminal")?.props["data-visible"]).toBe("false");
  });

  test("exposes Editor and Terminal mode switch actions", () => {
    const selected: string[] = [];
    const tree = CenterWorkbenchView({
      mode: "terminal",
      onModeChange(mode) {
        selected.push(mode);
      },
      editorPane: <div />,
      terminalPane: <div />,
    });

    const editorButton = findElementByPredicate(
      tree,
      (element) => element.props?.["data-action"] === "center-mode-switch" && element.props?.["data-mode"] === "editor",
    );
    const terminalButton = findElementByPredicate(
      tree,
      (element) => element.props?.["data-action"] === "center-mode-switch" && element.props?.["data-mode"] === "terminal",
    );

    expect(editorButton).toBeDefined();
    expect(terminalButton?.props["data-active"]).toBe("true");
    editorButton?.props.onClick();
    expect(selected).toEqual(["editor"]);
  });
});

function findElementByPredicate(
  node: ReactNode,
  predicate: (element: ReactElement) => boolean,
): ReactElement | undefined {
  if (isReactElement(node)) {
    if (predicate(node)) {
      return node;
    }

    if (typeof node.type === "function") {
      return findElementByPredicate(node.type(node.props), predicate);
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

function isReactElement(node: ReactNode): node is ReactElement {
  return typeof node === "object" && node !== null && "props" in node;
}
