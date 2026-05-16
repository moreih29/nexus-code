/**
 * Scenario regression tests for history ref chip ordering, overflow, and actions.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { ReactElement, ReactNode } from "react";
import * as React from "react";
import type { LogEntryRef } from "../../../../../../src/shared/git/types";

mock.module("react-dom", () => ({
  createPortal: (children: ReactNode) => children,
}));

const { RefChip, RefChipList, refChipDisplayKind, sortRefsForDisplay } = await import(
  "../../../../../../src/renderer/components/files/git/history/ref-chip"
);

type EffectCallback = () => undefined | (() => void);

type ReactDispatcher = {
  useCallback: <T extends (...args: never[]) => unknown>(callback: T) => T;
  useEffect: (callback: EffectCallback) => void;
  useId: () => string;
  useMemo: <T>(factory: () => T) => T;
  useRef: <T>(initialValue: T) => { current: T };
  useState: <T>(initialValue: T | (() => T)) => [T, (next: T | ((current: T) => T)) => void];
};

type RefChipListProps = Parameters<typeof RefChipList>[0];
type RefChipProps = Parameters<typeof RefChip>[0];

type TestNode = TestDomElement | TestTextNode;

/** Minimal text node used to preserve visible labels for assertions. */
class TestTextNode {
  parent: TestDomElement | null = null;

  constructor(readonly value: string) {}

  get textContent(): string {
    return this.value;
  }
}

/** Minimal DOM element replacement for React tree and mouse-event tests. */
class TestDomElement {
  readonly children: TestNode[] = [];
  parent: TestDomElement | null = null;
  readonly tagName: string;

  constructor(
    readonly type: string,
    readonly props: Record<string, unknown>,
  ) {
    this.tagName = type.toUpperCase();
  }

  append(child: TestNode): void {
    child.parent = this;
    this.children.push(child);
  }

  contains(target: unknown): boolean {
    if (target === this) return true;
    return this.children.some((child) => child instanceof TestDomElement && child.contains(target));
  }

  get textContent(): string {
    return this.children.map((child) => child.textContent).join("");
  }

  getBoundingClientRect(): DOMRect {
    return {
      x: 24,
      y: 32,
      width: 32,
      height: 20,
      top: 32,
      left: 24,
      right: 56,
      bottom: 52,
      toJSON: () => ({}),
    } as DOMRect;
  }
}

/** Tiny hook dispatcher that executes RefChipList hooks without a browser renderer. */
class HookHarness {
  private readonly hookValues: unknown[] = [];
  private cursor = 0;
  private effects: EffectCallback[] = [];
  private stateChanged = false;
  private idSequence = 0;

  readonly dispatcher: ReactDispatcher = {
    useCallback: (callback) => callback,
    useEffect: (callback) => {
      this.effects.push(callback);
    },
    useId: () => {
      const slot = this.cursor++;
      if (!(slot in this.hookValues)) {
        this.idSequence += 1;
        this.hookValues[slot] = `ref-chip-id-${this.idSequence}`;
      }
      return this.hookValues[slot] as string;
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
        root = roots.find((node): node is TestDomElement => node instanceof TestDomElement) ?? null;
      });
      for (const effect of this.effects) effect();
      if (!this.stateChanged) break;
    }

    if (!root) throw new Error("RefChip render produced no root element");
    return root;
  }
}

/** Stateful test view that re-renders after synthetic events. */
class RefChipListView {
  private readonly harness = new HookHarness();
  root: TestDomElement;

  constructor(private readonly props: RefChipListProps) {
    this.root = this.render();
  }

  render(): TestDomElement {
    this.root = this.harness.render(React.createElement(RefChipList, this.props));
    return this.root;
  }
}

const originalDocument = (globalThis as { document?: unknown }).document;
const originalWindow = (globalThis as { window?: unknown }).window;
const originalNode = (globalThis as { Node?: unknown }).Node;

beforeEach(() => {
  installDomGlobals();
});

afterEach(() => {
  restoreDomGlobals();
});

describe("RefChip sorting priority", () => {
  it("sorts a mixed decoration set as HEAD, current branch, local, remote, then tag", () => {
    const refs = [
      ref("v1.0.0", "tag"),
      ref("origin/main", "remote"),
      ref("feature/work", "branch"),
      ref("main", "branch"),
      ref("HEAD", "head", true),
    ];

    expect(sortNames(refs, "main")).toEqual([
      "HEAD",
      "main",
      "feature/work",
      "origin/main",
      "v1.0.0",
    ]);
  });

  it("treats a local branch marked isHead as current and keeps other local tie order", () => {
    const refs = [ref("beta", "branch"), ref("active", "branch", true), ref("alpha", "branch")];

    expect(sortNames(refs)).toEqual(["active", "beta", "alpha"]);
  });

  it("preserves Git order among equal-priority remotes after local branches", () => {
    const refs = [
      ref("upstream/main", "remote"),
      ref("origin/main", "remote"),
      ref("feature", "branch"),
    ];

    expect(sortNames(refs)).toEqual(["feature", "upstream/main", "origin/main"]);
  });

  it("keeps tags behind remote-tracking refs even when Git sends the tag first", () => {
    const refs = [ref("v2.0.0", "tag"), ref("origin/release", "remote"), ref("release", "branch")];

    expect(sortNames(refs)).toEqual(["release", "origin/release", "v2.0.0"]);
  });
});

describe("RefChip rendering semantics", () => {
  it("exposes full ref names through title, truncates the visible label, and labels all visual kinds", () => {
    const longName = "feature/super-long-branch-name-needs-truncation";
    const cases = [
      {
        refInfo: ref("HEAD", "head", true),
        currentRefName: "main",
        ariaLabel: "HEAD ref",
        classToken: "bg-[var(--color-git-chip-head-bg)]",
        displayKind: "head",
      },
      {
        refInfo: ref("main", "branch"),
        currentRefName: "main",
        ariaLabel: "Current branch main",
        classToken: "border-[var(--color-git-chip-border-strong)]",
        displayKind: "current",
      },
      {
        refInfo: ref(longName, "branch"),
        currentRefName: "main",
        ariaLabel: `Branch ${longName}`,
        classToken: "border-[var(--color-git-chip-border)]",
        displayKind: "branch",
      },
      {
        refInfo: ref("origin/main", "remote"),
        currentRefName: "main",
        ariaLabel: "Remote branch origin/main",
        classToken: "border-dashed",
        displayKind: "remote",
      },
      {
        refInfo: ref("v1.0.0", "tag"),
        currentRefName: "main",
        ariaLabel: "Tag v1.0.0",
        classToken: "rounded-[3px]",
        displayKind: "tag",
      },
    ] as const;

    for (const item of cases) {
      const button = renderRefChip({
        refInfo: item.refInfo,
        currentRefName: item.currentRefName,
        onRefChange: () => {},
      });

      expect(refChipDisplayKind(item.refInfo, item.currentRefName)).toBe(item.displayKind);
      expect(button.props.title).toBe(item.refInfo.name);
      expect(button.props["aria-label"]).toBe(item.ariaLabel);
      expect(button.textContent).toBe(item.refInfo.name);
      expect(String(button.props.className)).toContain("max-w-[14ch]");
      expect(String(button.props.className)).toContain(item.classToken);
      expect(textSpanFor(button, item.refInfo.name).props.className).toContain("truncate");
    }
  });
});

describe("RefChipList overflow behavior", () => {
  it("shows two visible refs by default and opens a +N popover for the hidden refs", () => {
    const view = renderRefChipList({ refs: mixedRefs(), currentRefName: "main" });

    expect(buttonTexts(view.root)).toEqual(["HEAD", "main", "+2"]);
    const overflow = buttonByLabel(view.root, "Show 2 more refs");
    expect(overflow.props["aria-expanded"]).toBe(false);

    const clickEvent = click(view, overflow);

    expect(clickEvent.propagationStopped).toBe(true);
    const reopenedOverflow = buttonByLabel(view.root, "Show 2 more refs");
    expect(reopenedOverflow.props["aria-expanded"]).toBe(true);
    expect(reopenedOverflow.props["aria-controls"]).toBeTruthy();
    expect(getByRole(view.root, "menu").props["aria-label"]).toBe("More refs");
    expect(getAllByRole(view.root, "menuitem").map((button) => button.textContent)).toEqual([
      "origin/main",
      "v1.0.0",
    ]);
  });

  it("renders no overflow trigger when all refs fit the visible count", () => {
    const view = renderRefChipList({ refs: [ref("main", "branch"), ref("v1.0.0", "tag")] });

    expect(buttonTexts(view.root)).toEqual(["main", "v1.0.0"]);
    expect(queryButtonByLabel(view.root, /Show \d+ more refs/)).toBeNull();
    expect(getAllByRole(view.root, "menu")).toHaveLength(0);
  });

  it("narrow density shows one visible ref and moves the rest behind +N", () => {
    const view = renderRefChipList({
      refs: mixedRefs(),
      currentRefName: "main",
      visibleCount: 1,
    });

    expect(buttonTexts(view.root)).toEqual(["HEAD", "+3"]);
    click(view, buttonByLabel(view.root, "Show 3 more refs"));
    expect(getAllByRole(view.root, "menuitem").map((button) => button.textContent)).toEqual([
      "main",
      "origin/main",
      "v1.0.0",
    ]);
  });

  it("adapts visible refs from history list breakpoints", () => {
    const narrow = renderRefChipList({
      refs: mixedRefs(),
      currentRefName: "main",
      breakpoint: "narrow",
    });
    expect(buttonTexts(narrow.root)).toEqual([""]);
    expect(buttonByLabel(narrow.root, "HEAD ref").props.title).toBe("HEAD");
    expect(queryButtonByLabel(narrow.root, /Show \d+ more refs/)).toBeNull();

    const medium = renderRefChipList({
      refs: mixedRefs(),
      currentRefName: "main",
      breakpoint: "medium",
    });
    expect(buttonTexts(medium.root)).toEqual(["HEAD", "+3"]);

    const wide = renderRefChipList({
      refs: mixedRefs(),
      currentRefName: "main",
      breakpoint: "wide",
    });
    expect(buttonTexts(wide.root)).toEqual(["HEAD", "main", "+2"]);
  });

  it("clicking an overflow ref navigates to the full hidden ref and closes the popover", () => {
    const onRefChange = mock((_refName: string) => {});
    const view = renderRefChipList({
      refs: mixedRefs(),
      currentRefName: "main",
      onRefChange,
    });

    click(view, buttonByLabel(view.root, "Show 2 more refs"));
    const remote = buttonByLabel(view.root, "Remote branch origin/main");
    const clickEvent = click(view, remote);

    expect(clickEvent.propagationStopped).toBe(true);
    expect(onRefChange).toHaveBeenCalledWith("origin/main");
    expect(getAllByRole(view.root, "menu")).toHaveLength(0);
    expect(buttonByLabel(view.root, "Show 2 more refs").props["aria-expanded"]).toBe(false);
  });
});

describe("RefChipList actions", () => {
  it("clicking a visible chip navigates with its ref name without bubbling to the row", () => {
    const onRefChange = mock((_refName: string) => {});
    const view = renderRefChipList({ refs: [ref("main", "branch")], onRefChange });

    const event = click(view, buttonByLabel(view.root, "Branch main"));

    expect(onRefChange).toHaveBeenCalledWith("main");
    expect(event.propagationStopped).toBe(true);
    expect(event.defaultPrevented).toBe(false);
  });

  it("forwards right-clicks from chips and overflow triggers to the existing menu handler", () => {
    const onRefChange = mock((_refName: string) => {});
    const onOpenMenu = mock((_event: unknown, _refInfo?: LogEntryRef) => {});
    const refs = [ref("HEAD", "head", true), ref("main", "branch"), ref("v1.0.0", "tag")];
    const view = renderRefChipList({ refs, currentRefName: "main", onRefChange, onOpenMenu });

    const chipEvent = contextMenu(view, buttonByLabel(view.root, "HEAD ref"));
    const overflowEvent = contextMenu(view, buttonByLabel(view.root, "Show 1 more refs"));

    expect(chipEvent.defaultPrevented).toBe(true);
    expect(chipEvent.propagationStopped).toBe(true);
    expect(overflowEvent.defaultPrevented).toBe(true);
    expect(overflowEvent.propagationStopped).toBe(true);
    expect(onOpenMenu.mock.calls).toEqual([
      [chipEvent, refs[0]],
      [overflowEvent, undefined],
    ]);
    expect(onRefChange).not.toHaveBeenCalled();
  });
});

/** Installs the browser globals touched by RefChipList during portal/open logic. */
function installDomGlobals(): void {
  const body = new TestDomElement("body", {});
  (globalThis as { Node?: unknown }).Node = TestDomElement;
  (globalThis as { document?: unknown }).document = {
    body,
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  (globalThis as { window?: unknown }).window = {
    innerWidth: 1024,
    innerHeight: 768,
  };
}

/** Restores globals so this file does not leak a fake DOM into nearby tests. */
function restoreDomGlobals(): void {
  if (originalDocument === undefined) {
    delete (globalThis as { document?: unknown }).document;
  } else {
    (globalThis as { document?: unknown }).document = originalDocument;
  }

  if (originalWindow === undefined) {
    delete (globalThis as { window?: unknown }).window;
  } else {
    (globalThis as { window?: unknown }).window = originalWindow;
  }

  if (originalNode === undefined) {
    delete (globalThis as { Node?: unknown }).Node;
  } else {
    (globalThis as { Node?: unknown }).Node = originalNode;
  }
}

/** Builds a LogEntryRef fixture with Git's ref decoration shape. */
function ref(name: string, kind: LogEntryRef["kind"], isHead = false): LogEntryRef {
  return { name, kind, isHead };
}

/** Returns a representative mixed ref set for dense-row scenarios. */
function mixedRefs(): LogEntryRef[] {
  return [
    ref("v1.0.0", "tag"),
    ref("origin/main", "remote"),
    ref("main", "branch"),
    ref("HEAD", "head", true),
  ];
}

/** Sorts a fixture set and returns only user-visible ref names. */
function sortNames(refs: readonly LogEntryRef[], currentRefName?: string): string[] {
  return sortRefsForDisplay(refs, currentRefName).map((refInfo) => refInfo.name);
}

/** Renders a single chip and returns its button element. */
function renderRefChip(props: RefChipProps): TestDomElement {
  const root = new HookHarness().render(React.createElement(RefChip, props));
  if (root.type !== "button") throw new Error("expected RefChip to render a button");
  return root;
}

/** Creates a stateful RefChipList view with scenario defaults. */
function renderRefChipList(overrides: Partial<RefChipListProps>): RefChipListView {
  return new RefChipListView({
    refs: [],
    onRefChange: () => {},
    ...overrides,
  });
}

/** Executes a React node tree into minimal DOM-like nodes. */
function renderReactNode(node: ReactNode): TestNode[] {
  if (node === null || node === undefined || typeof node === "boolean") return [];
  if (typeof node === "string" || typeof node === "number") return [new TestTextNode(String(node))];
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

/** Narrows arbitrary React nodes to element records. */
function isReactElement(node: ReactNode): node is ReactElement<Record<string, unknown>> {
  return typeof node === "object" && node !== null && "type" in node && "props" in node;
}

/** Applies function and object refs for the fake renderer. */
function attachRef(refValue: unknown, element: TestDomElement): void {
  if (typeof refValue === "function") {
    refValue(element);
    return;
  }
  if (refValue && typeof refValue === "object" && "current" in refValue) {
    (refValue as { current: TestDomElement | null }).current = element;
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

/** Finds a text span by its rendered content. */
function textSpanFor(root: TestDomElement, text: string): TestDomElement {
  const span = getAllByTag(root, "span").find((node) => node.textContent === text);
  if (!span) throw new Error(`Missing text span for ${text}`);
  return span;
}

/** Collects all elements with the requested tag name. */
function getAllByTag(root: TestDomElement, tagName: string): TestDomElement[] {
  const matches: TestDomElement[] = [];
  visit(root, (node) => {
    if (node.type === tagName) matches.push(node);
  });
  return matches;
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

/** Returns all button text labels in DOM order. */
function buttonTexts(root: TestDomElement): string[] {
  return getAllByTag(root, "button").map((button) => button.textContent);
}

/** Finds a button by accessible label and throws when absent. */
function buttonByLabel(root: TestDomElement, label: string | RegExp): TestDomElement {
  const button = queryButtonByLabel(root, label);
  if (!button) throw new Error(`Missing button ${String(label)}`);
  return button;
}

/** Finds a button by accessible label and returns null when absent. */
function queryButtonByLabel(root: TestDomElement, label: string | RegExp): TestDomElement | null {
  return (
    getAllByTag(root, "button").find((button) => {
      const ariaLabel = String(button.props["aria-label"] ?? "");
      return typeof label === "string" ? ariaLabel === label : label.test(ariaLabel);
    }) ?? null
  );
}

/** Depth-first traversal over fake DOM elements. */
function visit(root: TestDomElement, visitor: (node: TestDomElement) => void): void {
  visitor(root);
  for (const child of root.children) {
    if (child instanceof TestDomElement) visit(child, visitor);
  }
}

/** Dispatches a click event and re-renders pending state. */
function click(view: RefChipListView, element: TestDomElement): ReturnType<typeof mouseEvent> {
  const event = mouseEvent(element);
  callHandler(element.props.onClick, event);
  view.render();
  return event;
}

/** Dispatches a context-menu event and re-renders pending state. */
function contextMenu(
  view: RefChipListView,
  element: TestDomElement,
): ReturnType<typeof mouseEvent> {
  const event = mouseEvent(element);
  callHandler(element.props.onContextMenu, event);
  view.render();
  return event;
}

/** Creates the mouse event subset used by RefChip and RefChipList handlers. */
function mouseEvent(currentTarget: TestDomElement) {
  return {
    currentTarget,
    target: currentTarget,
    clientX: 88,
    clientY: 144,
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

/** Invokes a captured React handler with an intentionally small event object. */
function callHandler(handler: unknown, event: unknown): void {
  if (typeof handler !== "function") throw new Error("Missing event handler");
  handler(event);
}
