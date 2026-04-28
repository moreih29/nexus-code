import { afterEach, describe, expect, test } from "bun:test";
import type { ReactElement, ReactNode } from "react";

import {
  CENTER_SPLIT_RATIO_STORAGE_KEY,
  CENTER_TERMINAL_MIN_HEIGHT,
  CenterWorkbenchView,
  DEFAULT_CENTER_EDITOR_SPLIT_RATIO,
  clampCenterSplitRatio,
  parseCenterSplitRatio,
  readStoredCenterSplitRatio,
} from "./CenterWorkbench";

afterEach(() => {
  globalThis.localStorage?.removeItem(CENTER_SPLIT_RATIO_STORAGE_KEY);
});

describe("CenterWorkbenchView", () => {
  test("defaults to split layout with editor and terminal mounted around a horizontal resize handle", () => {
    const tree = CenterWorkbenchView({
      mode: "split",
      activePane: "editor",
      onActivePaneChange() {},
      onModeChange() {},
      editorPane: <div data-test-pane="editor">Editor pane</div>,
      terminalPane: <div data-test-pane="terminal">Terminal pane</div>,
    });

    const editorPanel = findElementByPredicate(tree, (element) => element.props?.["data-center-pane"] === "editor");
    const terminalPanel = findElementByPredicate(tree, (element) => element.props?.["data-center-pane"] === "terminal");
    const resizeHandle = findElementByPredicate(tree, (element) => element.props?.role === "separator");

    expect(findElementByPredicate(tree, (element) => element.props?.["data-test-pane"] === "editor")).toBeDefined();
    expect(findElementByPredicate(tree, (element) => element.props?.["data-test-pane"] === "terminal")).toBeDefined();
    expect(editorPanel?.props["data-visible"]).toBe("true");
    expect(terminalPanel?.props["data-visible"]).toBe("true");
    expect(editorPanel?.props.style.flexBasis).toBe(`${DEFAULT_CENTER_EDITOR_SPLIT_RATIO * 100}%`);
    expect(String(editorPanel?.props.className)).toContain("ring-1 ring-inset ring-[var(--color-ring)]");
    expect(terminalPanel?.props.style.minHeight).toBe(CENTER_TERMINAL_MIN_HEIGHT);
    expect(resizeHandle?.props["aria-orientation"]).toBe("horizontal");
    expect(String(resizeHandle?.props.className)).toContain("cursor-row-resize");
  });

  test("maximized mode keeps inactive pane mounted with visibility hidden and zero height", () => {
    const tree = CenterWorkbenchView({
      mode: "editor-max",
      activePane: "editor",
      onActivePaneChange() {},
      onModeChange() {},
      editorPane: <div data-test-pane="editor">Editor pane</div>,
      terminalPane: <div data-test-pane="terminal">Terminal pane</div>,
    });

    const terminalPanel = findElementByPredicate(tree, (element) => element.props?.["data-center-pane"] === "terminal");

    expect(findElementByPredicate(tree, (element) => element.props?.["data-test-pane"] === "terminal")).toBeDefined();
    expect(terminalPanel?.props["data-visible"]).toBe("false");
    expect(terminalPanel?.props.style.visibility).toBe("hidden");
    expect(terminalPanel?.props.style.height).toBe(0);
    expect(terminalPanel?.props.style.display).not.toBe("none");
    expect(String(terminalPanel?.props.className).split(/\s+/)).not.toContain("hidden");
  });

  test("keeps editor and terminal children rendered through 50+ maximize cycles without console errors", () => {
    const originalError = console.error;
    const errors: unknown[][] = [];
    console.error = (...args: unknown[]) => {
      errors.push(args);
    };

    try {
      const modes = ["split", "editor-max", "terminal-max"] as const;

      for (let index = 0; index < 51; index += 1) {
        const tree = CenterWorkbenchView({
          mode: modes[index % modes.length],
          activePane: index % 2 === 0 ? "editor" : "terminal",
          onActivePaneChange() {},
          onModeChange() {},
          editorPane: <div data-test-pane="editor">Editor pane</div>,
          terminalPane: <div data-test-pane="terminal">Terminal pane</div>,
        });
        const editorPanel = findElementByPredicate(tree, (element) => element.props?.["data-center-pane"] === "editor");
        const terminalPanel = findElementByPredicate(tree, (element) => element.props?.["data-center-pane"] === "terminal");

        expect(findElementByPredicate(tree, (element) => element.props?.["data-test-pane"] === "editor")).toBeDefined();
        expect(findElementByPredicate(tree, (element) => element.props?.["data-test-pane"] === "terminal")).toBeDefined();

        if (modes[index % modes.length] === "terminal-max") {
          expect(editorPanel?.props.style.visibility).toBe("hidden");
          expect(editorPanel?.props.style.height).toBe(0);
          expect(editorPanel?.props.style.display).not.toBe("none");
        }

        if (modes[index % modes.length] === "editor-max") {
          expect(terminalPanel?.props.style.visibility).toBe("hidden");
          expect(terminalPanel?.props.style.height).toBe(0);
          expect(terminalPanel?.props.style.display).not.toBe("none");
        }
      }
    } finally {
      console.error = originalError;
    }

    expect(errors).toEqual([]);
  });

  test("header buttons maximize and restore panes without exposing the old segmented control", () => {
    const selected: string[] = [];
    const tree = CenterWorkbenchView({
      mode: "split",
      activePane: "terminal",
      onActivePaneChange() {},
      onModeChange(mode) {
        selected.push(mode);
      },
      editorPane: <div />,
      terminalPane: <div />,
    });

    const terminalButton = findElementByPredicate(
      tree,
      (element) => element.props?.["data-action"] === "center-pane-toggle-maximize" && element.props?.["data-pane"] === "terminal",
    );
    const oldModeSwitch = findElementByPredicate(
      tree,
      (element) => element.props?.["data-action"] === "center-mode-switch",
    );
    const terminalTitle = findElementByPredicate(
      tree,
      (element) => element.props?.["data-center-pane-title"] === "terminal",
    );

    expect(oldModeSwitch).toBeUndefined();
    expect(terminalButton?.props.variant).toBe("ghost");
    expect(terminalTitle?.props["data-active"]).toBe("true");
    expect(String(terminalTitle?.props.className)).toContain("text-foreground");
    terminalButton?.props.onClick();
    expect(selected).toEqual(["terminal-max"]);
  });

  test("parses persisted split ratios with split default fallback", () => {
    expect(parseCenterSplitRatio(null)).toBe(DEFAULT_CENTER_EDITOR_SPLIT_RATIO);
    expect(parseCenterSplitRatio("0.7")).toBe(0.7);
    expect(parseCenterSplitRatio("bad ratio")).toBe(DEFAULT_CENTER_EDITOR_SPLIT_RATIO);
  });

  test("reads persisted split ratio and clamps terminal to at least 120px", () => {
    installMemoryLocalStorage().setItem(CENTER_SPLIT_RATIO_STORAGE_KEY, "0.72");

    expect(readStoredCenterSplitRatio()).toBe(0.72);
    expect(clampCenterSplitRatio(0.99, 300)).toBe((300 - CENTER_TERMINAL_MIN_HEIGHT) / 300);
    expect(clampCenterSplitRatio(0.99, 100)).toBe(0.05);
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
