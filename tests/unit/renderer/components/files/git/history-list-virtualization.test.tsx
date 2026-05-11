/**
 * Scenario verification for HistoryList virtualization, keyboard navigation, and ARIA.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { ReactElement, ReactNode } from "react";
import * as React from "react";
import type { LogEntry } from "../../../../../../src/shared/types/git";

const HISTORY_ROW_HEIGHT_PX = 24;
const DEFAULT_CLIENT_HEIGHT_PX = 72;

interface VirtualizerOptions {
  count: number;
  estimateSize: () => number;
  overscan?: number;
}

interface VirtualItem {
  key: string;
  index: number;
  start: number;
  size: number;
}

/** Deterministic virtualizer stand-in that preserves count, spacer, and scrollToIndex behavior. */
class VirtualizerHarness {
  visibleStart = 0;
  visibleCount = 8;
  readonly scrollCalls: number[] = [];
  lastOptions: VirtualizerOptions | null = null;

  reset(): void {
    this.visibleStart = 0;
    this.visibleCount = 8;
    this.scrollCalls.length = 0;
    this.lastOptions = null;
  }

  useVirtualizer(options: VirtualizerOptions) {
    this.lastOptions = options;
    return {
      getTotalSize: () => options.count * options.estimateSize(),
      getVirtualItems: () => this.getVirtualItems(options),
      scrollToIndex: (index: number) => {
        const clamped = clamp(index, 0, Math.max(0, options.count - 1));
        this.scrollCalls.push(clamped);
        this.visibleStart = clamp(clamped, 0, Math.max(0, options.count - this.visibleCount));
      },
    };
  }

  private getVirtualItems(options: VirtualizerOptions): VirtualItem[] {
    const overscan = options.overscan ?? 0;
    const size = options.estimateSize();
    const first = clamp(this.visibleStart - overscan, 0, Math.max(0, options.count));
    const last = clamp(
      this.visibleStart + this.visibleCount + overscan,
      first,
      Math.max(first, options.count),
    );

    return Array.from({ length: last - first }, (_, offset) => {
      const index = first + offset;
      return { key: `row-${index}`, index, start: index * size, size };
    });
  }
}

const virtualizer = new VirtualizerHarness();

mock.module("@tanstack/react-virtual", () => ({
  useVirtualizer: (options: VirtualizerOptions) => virtualizer.useVirtualizer(options),
}));

const { HistoryList } = await import(
  "../../../../../../src/renderer/components/files/git/history/HistoryList"
);

type HistoryListProps = Parameters<typeof HistoryList>[0];
type EffectCallback = () => undefined | (() => void);

type ReactDispatcher = {
  useCallback: <T extends (...args: never[]) => unknown>(callback: T) => T;
  useEffect: (callback: EffectCallback) => void;
  useLayoutEffect: (callback: EffectCallback) => void;
  useMemo: <T>(factory: () => T) => T;
  useRef: <T>(initialValue: T) => { current: T };
  useState: <T>(initialValue: T | (() => T)) => [T, (next: T | ((current: T) => T)) => void];
};

/** Tiny hook dispatcher that lets us execute this component without a DOM renderer. */
class HookHarness {
  private readonly hookValues: unknown[] = [];
  private cursor = 0;
  private effects: EffectCallback[] = [];
  private stateChanged = false;

  readonly dispatcher: ReactDispatcher = {
    useCallback: (callback) => callback,
    useEffect: (callback) => {
      this.effects.push(callback);
    },
    useLayoutEffect: (callback) => {
      this.effects.push(callback);
    },
    useMemo: (factory) => factory(),
    useRef: (initialValue) => {
      const slot = this.cursor++;
      if (!(slot in this.hookValues)) this.hookValues[slot] = { current: initialValue };
      return this.hookValues[slot] as { current: typeof initialValue };
    },
    useState: (initialValue) => {
      const slot = this.cursor++;
      if (!(slot in this.hookValues)) {
        this.hookValues[slot] =
          typeof initialValue === "function" ? (initialValue as () => unknown)() : initialValue;
      }
      const setState = (next: unknown) => {
        const current = this.hookValues[slot];
        const resolved =
          typeof next === "function" ? (next as (value: unknown) => unknown)(current) : next;
        if (Object.is(current, resolved)) return;
        this.hookValues[slot] = resolved;
        this.stateChanged = true;
      };
      return [this.hookValues[slot] as never, setState as never];
    },
  };

  render(element: ReactElement): TestDomElement {
    let root: TestDomElement | null = null;

    for (let pass = 0; pass < 10; pass += 1) {
      this.cursor = 0;
      this.effects = [];
      this.stateChanged = false;
      withReactDispatcher(this.dispatcher, () => {
        const roots = renderReactNode(element);
        root = roots[0] ?? null;
      });
      for (const effect of this.effects) effect();
      if (!this.stateChanged) break;
    }

    if (!root) throw new Error("HistoryList rendered no root element");
    return root;
  }
}

/** Minimal HTMLElement replacement for event target and focus assertions. */
class TestDomElement {
  readonly tagName: string;
  readonly children: TestDomElement[] = [];
  parent: TestDomElement | null = null;
  isContentEditable = false;
  clientHeight = DEFAULT_CLIENT_HEIGHT_PX;

  constructor(
    readonly type: string,
    readonly props: Record<string, unknown>,
  ) {
    this.tagName = type.toUpperCase();
  }

  append(child: TestDomElement): void {
    child.parent = this;
    this.children.push(child);
  }

  focus(): void {
    activeElement = this;
    const posInSet = this.props["aria-posinset"];
    activeOptionPosition = typeof posInSet === "number" ? posInSet : activeOptionPosition;
    const onFocus = this.props.onFocus;
    if (typeof onFocus === "function") {
      onFocus({ target: this, currentTarget: this });
    }
  }

  getBoundingClientRect(): DOMRect {
    return {
      x: 0,
      y: 0,
      width: 240,
      height: HISTORY_ROW_HEIGHT_PX,
      top: 0,
      left: 0,
      right: 240,
      bottom: HISTORY_ROW_HEIGHT_PX,
      toJSON: () => ({}),
    } as DOMRect;
  }
}

let activeElement: TestDomElement | null = null;
let activeOptionPosition: number | null = null;
const animationFrameCallbacks: FrameRequestCallback[] = [];
const originalHTMLElement = (globalThis as { HTMLElement?: unknown }).HTMLElement;
const originalWindow = (globalThis as { window?: unknown }).window;

beforeEach(() => {
  installDomGlobals();
  virtualizer.reset();
  activeElement = null;
  activeOptionPosition = null;
  animationFrameCallbacks.length = 0;
});

afterEach(() => {
  restoreDomGlobals();
});

/** Installs only the browser globals that HistoryList touches during synthetic events. */
function installDomGlobals(): void {
  (globalThis as unknown as { HTMLElement: typeof TestDomElement }).HTMLElement = TestDomElement;
  (
    globalThis as unknown as {
      window: Record<string, unknown> & {
        requestAnimationFrame: (cb: FrameRequestCallback) => number;
      };
    }
  ).window = {
    ...((originalWindow as Record<string, unknown> | undefined) ?? {}),
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      animationFrameCallbacks.push(callback);
      return animationFrameCallbacks.length;
    },
  };
}

/** Restores globals so this file does not contaminate broader git test runs. */
function restoreDomGlobals(): void {
  if (originalHTMLElement === undefined) {
    delete (globalThis as { HTMLElement?: unknown }).HTMLElement;
  } else {
    (globalThis as { HTMLElement?: unknown }).HTMLElement = originalHTMLElement;
  }

  if (originalWindow === undefined) {
    delete (globalThis as { window?: unknown }).window;
  } else {
    (globalThis as { window?: unknown }).window = originalWindow;
  }
}

describe("HistoryList virtualization and ARIA", () => {
  it("renders listbox options with set size, position, and selected row metadata", () => {
    const view = renderHistoryList({ entries: makeEntries(12), selectedSha: shaForIndex(4) });

    const listbox = getByRole(view.root, "listbox");
    const options = getAllByRole(view.root, "option");

    expect(listbox.props["aria-label"]).toBe("Commit history");
    expect(options).toHaveLength(12);
    expect(optionAtPosition(view.root, 1).props["aria-setsize"]).toBe(12);
    expect(optionAtPosition(view.root, 1).props["aria-posinset"]).toBe(1);
    expect(optionAtPosition(view.root, 5).props["aria-selected"]).toBe(true);
    expect(optionAtPosition(view.root, 12).props["aria-posinset"]).toBe(12);
  });

  it("mounts only a bounded virtual window for 1000+ entries and keeps a total-height spacer", () => {
    const view = renderHistoryList({ entries: makeEntries(1_005) });
    const listbox = getByRole(view.root, "listbox");
    const options = getAllByRole(view.root, "option");

    expect(virtualizer.lastOptions?.count).toBe(1_005);
    expect(virtualizer.lastOptions?.estimateSize()).toBe(HISTORY_ROW_HEIGHT_PX);
    expect((listbox.props.style as { height: number }).height).toBe(1_005 * HISTORY_ROW_HEIGHT_PX);
    expect(options.length).toBeGreaterThanOrEqual(virtualizer.visibleCount);
    expect(options.length).toBeLessThan(1_005);
    expect(optionAtPosition(view.root, 1).props["aria-posinset"]).toBe(1);

    virtualizer.visibleStart = 700;
    view.render();

    const recycledPositions = getAllByRole(view.root, "option").map(
      (option) => option.props["aria-posinset"],
    );
    expect(recycledPositions).toContain(701);
    expect(recycledPositions).not.toContain(1);
  });
});

describe("HistoryList keyboard navigation", () => {
  it("moves focus with ArrowUp, ArrowDown, PageDown, and PageUp while clamping bounds", () => {
    const view = renderHistoryList({ entries: makeEntries(8) });

    focusListbox(view);
    expect(activeOptionPosition).toBe(1);

    const arrowUpAtStart = pressListKey(view, "ArrowUp");
    expect(arrowUpAtStart.defaultPrevented).toBe(true);
    expect(activeOptionPosition).toBe(1);
    expect(optionAtPosition(view.root, 1).props.tabIndex).toBe(0);

    const arrowDown = pressListKey(view, "ArrowDown");
    expect(arrowDown.defaultPrevented).toBe(true);
    expect(activeOptionPosition).toBe(2);
    expect(optionAtPosition(view.root, 2).props.tabIndex).toBe(0);

    const pageDown = pressListKey(view, "PageDown");
    expect(pageDown.defaultPrevented).toBe(true);
    expect(activeOptionPosition).toBe(5);
    expect(virtualizer.scrollCalls.at(-1)).toBe(4);

    const pageUp = pressListKey(view, "PageUp");
    expect(pageUp.defaultPrevented).toBe(true);
    expect(activeOptionPosition).toBe(2);
    expect(virtualizer.scrollCalls.at(-1)).toBe(1);

    pressListKey(view, "PageDown");
    pressListKey(view, "PageDown");
    expect(activeOptionPosition).toBe(8);

    const arrowDownAtEnd = pressListKey(view, "ArrowDown");
    expect(arrowDownAtEnd.defaultPrevented).toBe(true);
    expect(activeOptionPosition).toBe(8);
    expect(optionAtPosition(view.root, 8).props.tabIndex).toBe(0);
  });

  it("scrolls before focusing when PageDown lands on an unmounted virtual row", () => {
    const view = renderHistoryList({ entries: makeEntries(1_000) });
    expect(
      getAllByRole(view.root, "option").map((row) => row.props["aria-posinset"]),
    ).not.toContain(31);

    focusListbox(view);
    view.root.clientHeight = 720;
    const pageDown = pressListKey(view, "PageDown");

    expect(pageDown.defaultPrevented).toBe(true);
    expect(pageDown.propagationStopped).toBe(true);
    expect(virtualizer.scrollCalls.at(-1)).toBe(30);
    expect(optionAtPosition(view.root, 31).props.tabIndex).toBe(0);
    expect(activeOptionPosition).toBe(31);
  });

  it("leaves editable key targets alone", () => {
    const view = renderHistoryList({ entries: makeEntries(6) });
    focusListbox(view);

    const editable = new TestDomElement("input", {});
    const event = makeKeyEvent("ArrowDown", editable);
    callHandler(getByRole(view.root, "listbox").props.onKeyDown, event);
    view.render();

    expect(event.defaultPrevented).toBe(false);
    expect(event.propagationStopped).toBe(false);
    expect(activeOptionPosition).toBe(1);
  });
});

/** Re-renders HistoryList and keeps its hook state between synthetic events. */
class HistoryListView {
  readonly harness = new HookHarness();
  root: TestDomElement;

  constructor(private readonly props: HistoryListProps) {
    this.root = this.render();
  }

  render(): TestDomElement {
    this.root = this.harness.render(React.createElement(HistoryList, this.props));
    return this.root;
  }
}

/** Creates a stateful HistoryList test view with scenario defaults. */
function renderHistoryList(overrides: Partial<HistoryListProps>): HistoryListView {
  return new HistoryListView({
    entries: [],
    selectedSha: null,
    loading: false,
    loadingMore: false,
    hasMore: false,
    searchQuery: "",
    onSelect: () => {},
    onLoadMore: () => {},
    onOpenMenu: () => {},
    onClearSearch: () => {},
    ...overrides,
  });
}

/** Executes a React function component tree into minimal DOM-like nodes. */
function renderReactNode(node: ReactNode): TestDomElement[] {
  if (node === null || node === undefined || typeof node === "boolean") return [];
  if (typeof node === "string" || typeof node === "number") return [];
  if (Array.isArray(node)) return node.flatMap((child) => renderReactNode(child));
  if (!isReactElement(node)) return [];

  const { type, props } = node;
  if (type === React.Fragment) return renderReactNode(props.children as ReactNode);
  if (typeof type === "function") return renderReactNode(type(props as never) as ReactNode);
  if (typeof type !== "string") return [];

  const element = new TestDomElement(type, props as Record<string, unknown>);
  for (const child of renderReactNode(props.children as ReactNode)) element.append(child);
  attachRef(props.ref, element);
  return [element];
}

/** Narrows arbitrary ReactNode values to element records. */
function isReactElement(node: ReactNode): node is ReactElement<Record<string, unknown>> {
  return typeof node === "object" && node !== null && "type" in node && "props" in node;
}

/** Applies function and object refs for the fake renderer. */
function attachRef(ref: unknown, element: TestDomElement): void {
  if (typeof ref === "function") {
    ref(element);
    return;
  }
  if (ref && typeof ref === "object" && "current" in ref) {
    (ref as { current: TestDomElement | null }).current = element;
  }
}

/** Runs a render pass under the test hook dispatcher. */
function withReactDispatcher<T>(dispatcher: ReactDispatcher, callback: () => T): T {
  const internals = (
    React as unknown as {
      __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: {
        H: ReactDispatcher | null;
      };
    }
  ).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  const previous = internals.H;
  internals.H = dispatcher;
  try {
    return callback();
  } finally {
    internals.H = previous;
  }
}

/** Finds the first fake DOM node with a specific ARIA role. */
function getByRole(root: TestDomElement, role: string): TestDomElement {
  const match = getAllByRole(root, role)[0];
  if (!match) throw new Error(`Missing role ${role}`);
  return match;
}

/** Collects all fake DOM nodes with a specific ARIA role. */
function getAllByRole(root: TestDomElement, role: string): TestDomElement[] {
  const matches: TestDomElement[] = [];
  visit(root, (node) => {
    if (node.props.role === role) matches.push(node);
  });
  return matches;
}

/** Finds an option by aria-posinset. */
function optionAtPosition(root: TestDomElement, position: number): TestDomElement {
  const option = getAllByRole(root, "option").find(
    (node) => node.props["aria-posinset"] === position,
  );
  if (!option) throw new Error(`Missing option at position ${position}`);
  return option;
}

/** Depth-first traversal over fake DOM nodes. */
function visit(root: TestDomElement, visitor: (node: TestDomElement) => void): void {
  visitor(root);
  for (const child of root.children) visit(child, visitor);
}

/** Focuses the listbox the way a keyboard user tabs into the list. */
function focusListbox(view: HistoryListView): void {
  const listbox = getByRole(view.root, "listbox");
  callHandler(listbox.props.onFocus, { target: listbox, currentTarget: listbox });
  view.render();
}

/** Dispatches one keyboard event to the listbox and re-renders pending state. */
function pressListKey(view: HistoryListView, key: string): ReturnType<typeof makeKeyEvent> {
  const event = makeKeyEvent(key, activeElement ?? getByRole(view.root, "listbox"));
  callHandler(getByRole(view.root, "listbox").props.onKeyDown, event);
  view.render();
  return event;
}

/** Creates the KeyboardEvent subset used by HistoryList. */
function makeKeyEvent(key: string, target: TestDomElement) {
  return {
    key,
    target,
    currentTarget: getCurrentTarget(target),
    defaultPrevented: false,
    propagationStopped: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
    stopPropagation() {
      this.propagationStopped = true;
    },
  };
}

/** Returns the nearest listbox ancestor when available. */
function getCurrentTarget(target: TestDomElement): TestDomElement {
  let current: TestDomElement | null = target;
  while (current) {
    if (current.props.role === "listbox") return current;
    current = current.parent;
  }
  return target;
}

/** Invokes a captured React handler with an intentionally small event object. */
function callHandler(handler: unknown, event: unknown): void {
  if (typeof handler !== "function") throw new Error("Missing event handler");
  handler(event);
}

/** Builds deterministic commit entries with sortable SHAs and subjects. */
function makeEntries(count: number): LogEntry[] {
  return Array.from({ length: count }, (_, index) => ({
    sha: shaForIndex(index),
    shortSha: `s${String(index).padStart(6, "0")}`,
    parents: index === count - 1 ? [] : [shaForIndex(index + 1)],
    authorName: `Author ${index}`,
    authorEmail: `author-${index}@example.invalid`,
    authoredAt: "2026-05-10T00:00:00.000Z",
    subject: `Commit ${index}`,
    body: "",
  }));
}

/** Produces a stable 40-character hexadecimal commit id. */
function shaForIndex(index: number): string {
  return index.toString(16).padStart(40, "0");
}

/** Clamps numeric test values to a range. */
function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
