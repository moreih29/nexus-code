import { afterEach, describe, expect, test } from "bun:test";
import type { ReactElement, ReactNode } from "react";

import {
  CENTER_BOTTOM_PANEL_MAX_SIZE,
  CENTER_BOTTOM_PANEL_MIN_SIZE,
  CENTER_BOTTOM_PANEL_SIZE_STORAGE_KEY,
  CenterWorkbenchView,
  DEFAULT_CENTER_BOTTOM_PANEL_SIZE,
  clampCenterBottomPanelSize,
  parseCenterBottomPanelSize,
  nextCenterBottomPanelSizeFromKeyboard,
  readStoredCenterBottomPanelSize,
} from "./CenterWorkbench";

const editorArea = <div data-test-area="editor">Editor grid</div>;
const bottomPanel = <div data-test-area="bottom-panel">Bottom panel</div>;

afterEach(() => {
  globalThis.localStorage?.removeItem(CENTER_BOTTOM_PANEL_SIZE_STORAGE_KEY);
});

describe("CenterWorkbenchView", () => {
  test("structures center as editor area plus Bottom Panel area, not a terminal sibling pane", () => {
    const tree = CenterWorkbenchView({
      editorArea,
      bottomPanel,
      bottomPanelPosition: "bottom",
      bottomPanelExpanded: true,
      bottomPanelSize: 360,
      activeArea: "editor",
    });

    const editorSection = findElementByPredicate(tree, (element) => element.props?.["data-center-area"] === "editor");
    const bottomPanelSection = findElementByPredicate(tree, (element) => element.props?.["data-center-area"] === "bottom-panel");
    const terminalSibling = findElementByPredicate(tree, (element) => element.props?.["data-center-pane"] === "terminal");
    const resizeHandle = findElementByPredicate(tree, (element) => element.props?.role === "separator");

    expect(findElementByPredicate(tree, (element) => element.props?.["data-test-area"] === "editor")).toBeDefined();
    expect(findElementByPredicate(tree, (element) => element.props?.["data-test-area"] === "bottom-panel")).toBeDefined();
    expect(terminalSibling).toBeUndefined();
    expect(editorSection?.props["data-active"]).toBe("true");
    expect(String(editorSection?.props.className)).not.toContain("ring-1 ring-inset");
    expect(String(editorSection?.props.className)).toContain("focus-visible:outline-1");
    expect(String(editorSection?.props.className)).toContain("has-[:focus-visible]:outline-1");
    expect(bottomPanelSection?.props["data-bottom-panel-position"]).toBe("bottom");
    expect(String(bottomPanelSection?.props.className)).not.toContain("ring-1 ring-inset");
    expect(String(bottomPanelSection?.props.className)).toContain("focus-visible:outline-1");
    expect(bottomPanelSection?.props.style.flexBasis).toBe(360);
    expect(resizeHandle?.props["aria-orientation"]).toBe("horizontal");
    expect(resizeHandle?.props["aria-label"]).toBe("Resize bottom panel");
  });

  test("exposes left/right/top/bottom position hooks and switches resize orientation", () => {
    const positions = ["left", "right", "top", "bottom"] as const;

    for (const position of positions) {
      const tree = CenterWorkbenchView({
        editorArea,
        bottomPanel,
        bottomPanelPosition: position,
        bottomPanelExpanded: true,
        bottomPanelSize: 300,
        activeArea: "bottom-panel",
      });
      const workbench = findElementByPredicate(tree, (element) => element.props?.["data-component"] === "center-workbench");
      const bottomPanelSection = findElementByPredicate(tree, (element) => element.props?.["data-center-area"] === "bottom-panel");
      const resizeHandle = findElementByPredicate(tree, (element) => element.props?.role === "separator");

      expect(workbench?.props["data-bottom-panel-position"]).toBe(position);
      expect(bottomPanelSection?.props["data-active"]).toBe("true");
      expect(bottomPanelSection?.props["data-visible"]).toBe("true");
      expect(resizeHandle?.props["aria-orientation"]).toBe(position === "left" || position === "right" ? "vertical" : "horizontal");
    }
  });

  test("keeps Bottom Panel mounted when collapsed or editor-maximized", () => {
    const tree = CenterWorkbenchView({
      editorArea,
      bottomPanel,
      bottomPanelPosition: "bottom",
      bottomPanelExpanded: true,
      bottomPanelSize: 320,
      editorMaximized: true,
    });

    const bottomPanelSection = findElementByPredicate(tree, (element) => element.props?.["data-center-area"] === "bottom-panel");

    expect(findElementByPredicate(tree, (element) => element.props?.["data-test-area"] === "bottom-panel")).toBeDefined();
    expect(bottomPanelSection?.props["data-visible"]).toBe("false");
    expect(bottomPanelSection?.props.style.visibility).toBe("hidden");
    expect(bottomPanelSection?.props.style.height).toBe(0);
    expect(bottomPanelSection?.props.style.display).not.toBe("none");
  });

  test("computes position-aware keyboard resize deltas", () => {
    expect(nextCenterBottomPanelSizeFromKeyboard(320, "bottom", "ArrowUp")).toBe(336);
    expect(nextCenterBottomPanelSizeFromKeyboard(320, "bottom", "ArrowDown")).toBe(304);
    expect(nextCenterBottomPanelSizeFromKeyboard(320, "top", "ArrowDown")).toBe(336);
    expect(nextCenterBottomPanelSizeFromKeyboard(320, "left", "ArrowRight")).toBe(336);
    expect(nextCenterBottomPanelSizeFromKeyboard(320, "right", "ArrowLeft")).toBe(336);
    expect(nextCenterBottomPanelSizeFromKeyboard(320, "right", "Enter")).toBeNull();
  });

  test("parses and clamps persisted Bottom Panel sizes", () => {
    expect(parseCenterBottomPanelSize(null)).toBe(DEFAULT_CENTER_BOTTOM_PANEL_SIZE);
    expect(parseCenterBottomPanelSize("420")).toBe(420);
    expect(parseCenterBottomPanelSize("bad size")).toBe(DEFAULT_CENTER_BOTTOM_PANEL_SIZE);
    expect(clampCenterBottomPanelSize(1)).toBe(CENTER_BOTTOM_PANEL_MIN_SIZE);
    expect(clampCenterBottomPanelSize(9999)).toBe(CENTER_BOTTOM_PANEL_MAX_SIZE);

    installMemoryLocalStorage().setItem(CENTER_BOTTOM_PANEL_SIZE_STORAGE_KEY, "410");
    expect(readStoredCenterBottomPanelSize()).toBe(410);
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

function installMemoryLocalStorage(): Storage {
  const values = new Map<string, string>();
  const storage = {
    get length() {
      return values.size;
    },
    clear() {
      values.clear();
    },
    getItem(key: string) {
      return values.get(key) ?? null;
    },
    key(index: number) {
      return Array.from(values.keys())[index] ?? null;
    },
    removeItem(key: string) {
      values.delete(key);
    },
    setItem(key: string, value: string) {
      values.set(key, value);
    },
  } satisfies Storage;

  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: storage,
  });

  return storage;
}
