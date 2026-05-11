/**
 * Scenario verification for History all-branches scope, grep wiring, and toolbar semantics.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { ReactElement, ReactNode } from "react";
import * as React from "react";
import type { GitHistoryScope } from "../../../../../../src/shared/types/git";

type LogStreamArgs = {
  workspaceId?: string;
  ref?: string;
  scope?: string;
  grep?: string;
  limit?: number;
};

type IpcStreamCall = {
  channel: string;
  method: string;
  args: LogStreamArgs;
};

type IpcCallRecord = {
  channel: string;
  method: string;
  args: Record<string, unknown>;
};

const WORKSPACE_ID = "00000000-0000-0000-0000-000000000014";
const logStreamCalls: IpcStreamCall[] = [];
const ipcCallRecords: IpcCallRecord[] = [];

const ipcCallMock = mock((channel: string, method: string, args: Record<string, unknown>) => {
  ipcCallRecords.push({ channel, method, args });
  if (method === "searchCommits") return Promise.resolve({ kind: "grep", entries: [] });
  if (method === "commitDetail") return Promise.resolve(null);
  return Promise.resolve(undefined);
});

const ipcStreamMock = mock((channel: string, method: string, args: LogStreamArgs) => {
  logStreamCalls.push({ channel, method, args });
  return {
    promise: new Promise(() => {}),
    onProgress: mock(() => () => {}),
  };
});

mock.module("../../../../../../src/renderer/ipc/client", () => ({
  ipcCall: ipcCallMock,
  ipcListen: mock(() => () => {}),
  ipcStream: ipcStreamMock,
}));

mock.module("../../../../../../src/renderer/state/stores/git", () => ({
  useGitStore: (selector: (state: MockGitStoreState) => unknown) => selector(mockGitStoreState),
}));

mock.module("../../../../../../src/renderer/components/files/git/BranchPicker", () => ({
  BranchPicker: () => null,
}));

mock.module("../../../../../../src/renderer/components/files/git/history/HistoryList", () => ({
  HistoryList: () => React.createElement("section", { "aria-label": "mock history list" }),
}));

mock.module("../../../../../../src/renderer/components/files/git/history/HistoryDetail", () => ({
  HistoryDetail: () => null,
}));

mock.module(
  "../../../../../../src/renderer/components/files/git/history/HistoryCommitMenu",
  () => ({
    HistoryCommitMenu: () => null,
  }),
);

mock.module("../../../../../../src/renderer/components/files/git/history/RefChip", () => ({
  RefChipList: () => null,
}));

const { HistoryPanel } = await import(
  "../../../../../../src/renderer/components/files/git/history/HistoryPanel"
);

type MockGitStoreState = {
  cherryPick: () => Promise<boolean>;
  checkoutDetached: () => Promise<void>;
  resetSoft: () => Promise<void>;
};

const mockGitStoreState: MockGitStoreState = {
  cherryPick: async () => true,
  checkoutDetached: async () => {},
  resetSoft: async () => {},
};

type EffectCallback = () => undefined | (() => void);
type DependencyList = readonly unknown[] | undefined;

type ReactDispatcher = {
  useCallback: <T extends (...args: never[]) => unknown>(callback: T, deps?: DependencyList) => T;
  useEffect: (callback: EffectCallback, deps?: DependencyList) => void;
  useLayoutEffect: (callback: EffectCallback, deps?: DependencyList) => void;
  useMemo: <T>(factory: () => T, deps?: DependencyList) => T;
  useRef: <T>(initialValue: T) => { current: T };
  useState: <T>(initialValue: T | (() => T)) => [T, (next: T | ((current: T) => T)) => void];
};

type EffectRecord = {
  deps: DependencyList;
  cleanup?: () => void;
};

type MemoRecord<T> = {
  deps: DependencyList;
  value: T;
};

type TestNode = TestDomElement | TestTextNode;

/** Text node used by the fake renderer so accessible names and subtitles are assertable. */
class TestTextNode {
  parent: TestDomElement | null = null;

  constructor(readonly value: string) {}

  get textContent(): string {
    return this.value;
  }
}

/** Minimal DOM element record for React tree and event assertions. */
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

  get textContent(): string {
    return this.children.map((child) => child.textContent).join("");
  }

  get isContentEditable(): boolean {
    return false;
  }

  getBoundingClientRect(): DOMRect {
    return {
      x: 0,
      y: 0,
      width: 240,
      height: 28,
      top: 0,
      left: 0,
      right: 240,
      bottom: 28,
      toJSON: () => ({}),
    } as DOMRect;
  }
}

/** Hook dispatcher with dependency-aware effects so HistoryPanel streams run like React. */
class HookHarness {
  private readonly hookValues: unknown[] = [];
  private cursor = 0;
  private readonly pendingEffects: Array<{ slot: number; callback: EffectCallback }> = [];
  private stateChanged = false;

  readonly dispatcher: ReactDispatcher = {
    useCallback: (callback, deps) => this.useMemoValue(() => callback, deps),
    useEffect: (callback, deps) => this.queueEffect(callback, deps),
    useLayoutEffect: (callback, deps) => this.queueEffect(callback, deps),
    useMemo: (factory, deps) => this.useMemoValue(factory, deps),
    useRef: (initialValue) => {
      const slot = this.cursor;
      this.cursor += 1;
      if (!(slot in this.hookValues)) this.hookValues[slot] = { current: initialValue };
      return this.hookValues[slot] as { current: typeof initialValue };
    },
    useState: (initialValue) => {
      const slot = this.cursor;
      this.cursor += 1;
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

    for (let pass = 0; pass < 20; pass += 1) {
      this.cursor = 0;
      this.pendingEffects.length = 0;
      this.stateChanged = false;
      withReactDispatcher(this.dispatcher, () => {
        const roots = renderReactNode(element);
        root = roots.find((node): node is TestDomElement => node instanceof TestDomElement) ?? null;
      });
      this.runPendingEffects();
      if (!this.stateChanged) break;
    }

    if (!root) throw new Error("HistoryPanel rendered no root element");
    return root;
  }

  cleanup(): void {
    for (const value of this.hookValues) {
      const record = value as Partial<EffectRecord> | undefined;
      record?.cleanup?.();
    }
  }

  markStateChanged(): void {
    this.stateChanged = true;
  }

  private useMemoValue<T>(factory: () => T, deps: DependencyList): T {
    const slot = this.cursor;
    this.cursor += 1;
    const previous = this.hookValues[slot] as MemoRecord<T> | undefined;
    if (!previous || dependenciesChanged(previous.deps, deps)) {
      const next = { deps, value: factory() };
      this.hookValues[slot] = next;
      return next.value;
    }
    return previous.value;
  }

  private queueEffect(callback: EffectCallback, deps: DependencyList): void {
    const slot = this.cursor;
    this.cursor += 1;
    const previous = this.hookValues[slot] as EffectRecord | undefined;
    if (!previous) {
      this.hookValues[slot] = { deps } satisfies EffectRecord;
      this.pendingEffects.push({ slot, callback });
      return;
    }
    if (!dependenciesChanged(previous.deps, deps)) return;
    previous.deps = deps;
    this.pendingEffects.push({ slot, callback });
  }

  private runPendingEffects(): void {
    for (const { slot, callback } of this.pendingEffects) {
      const record = this.hookValues[slot] as EffectRecord;
      record.cleanup?.();
      const cleanup = callback();
      record.cleanup = typeof cleanup === "function" ? cleanup : undefined;
    }
  }
}

/** Controlled wrapper that plays the parent GitPanel role for scope/ref props. */
class HistoryPanelView {
  private readonly harness = new HookHarness();
  refName = "main";
  root: TestDomElement;

  constructor(private historyScope: GitHistoryScope) {
    this.root = this.render();
  }

  render(): TestDomElement {
    this.root = this.harness.render(
      React.createElement(HistoryPanel, {
        workspaceId: WORKSPACE_ID,
        refName: this.refName,
        historyScope: this.historyScope,
        detailWidth: 320,
        onRefChange: (nextRefName: string) => {
          this.refName = nextRefName;
        },
        onScopeChange: (nextScope: GitHistoryScope) => {
          this.historyScope = nextScope;
        },
        onDetailWidthChange: () => {},
      }),
    );
    return this.root;
  }

  typeSearch(query: string): void {
    const input = searchInput(this.root);
    callHandler(input.props.onChange, { target: { value: query } });
    this.render();
  }

  drainDebounceTimers(): void {
    drainWindowTimers();
    this.render();
  }

  cleanup(): void {
    this.harness.cleanup();
  }
}

const originalWindow = (globalThis as { window?: unknown }).window;
const originalDocument = (globalThis as { document?: unknown }).document;
const originalHTMLElement = (globalThis as { HTMLElement?: unknown }).HTMLElement;
let nextTimerId = 0;
let windowTimers = new Map<number, () => void>();
let activeView: HistoryPanelView | null = null;

beforeEach(() => {
  logStreamCalls.length = 0;
  ipcCallRecords.length = 0;
  ipcCallMock.mockClear();
  ipcStreamMock.mockClear();
  installDomGlobals();
});

afterEach(() => {
  activeView?.cleanup();
  activeView = null;
  restoreDomGlobals();
});

describe("HistoryPanel all-branches matrix", () => {
  it("streams the four ref/all × search/no-search combinations and announces each subtitle", () => {
    const scenarios: Array<{
      label: string;
      scope: GitHistoryScope;
      query: string;
      expected: { scope: GitHistoryScope; ref?: string; grep?: string };
      subtitle: string;
    }> = [
      {
        label: "single ref without search",
        scope: "ref",
        query: "",
        expected: { scope: "ref", ref: "main" },
        subtitle: "Viewing history of main",
      },
      {
        label: "single ref grep search",
        scope: "ref",
        query: "fix popover",
        expected: { scope: "ref", ref: "main", grep: "fix popover" },
        subtitle: "Viewing history of main · filtered by 'fix popover'",
      },
      {
        label: "all branches without search",
        scope: "all",
        query: "",
        expected: { scope: "all" },
        subtitle: "Viewing all branches · was: main",
      },
      {
        label: "all branches grep search",
        scope: "all",
        query: "fix popover",
        expected: { scope: "all", grep: "fix popover" },
        subtitle: "Viewing all branches · filtered by 'fix popover'",
      },
    ];

    for (const scenario of scenarios) {
      activeView?.cleanup();
      activeView = new HistoryPanelView(scenario.scope);

      if (scenario.query.length > 0) {
        logStreamCalls.length = 0;
        ipcCallRecords.length = 0;
        activeView.typeSearch(scenario.query);
        activeView.drainDebounceTimers();
      }

      const call = lastLogStreamCall(scenario.label);
      expect(call.channel).toBe("git");
      expect(call.method).toBe("log");
      expect(call.args.workspaceId).toBe(WORKSPACE_ID);
      expect(call.args.limit).toBe(50);
      expect(call.args.scope).toBe(scenario.expected.scope);
      expect(call.args.ref).toBe(scenario.expected.ref);
      expect(call.args.grep).toBe(scenario.expected.grep);
      expect(liveRegion(activeView.root).textContent).toBe(scenario.subtitle);
      expect(liveRegion(activeView.root).props["aria-live"]).toBe("polite");
      expect(liveRegion(activeView.root).props["aria-atomic"]).toBe("true");
      expect(ipcCallRecords.filter((record) => record.method === "searchCommits")).toHaveLength(0);
    }
  });

  it("keeps toolbar tab order as ref switcher, all-branches toggle, then refresh", () => {
    activeView = new HistoryPanelView("ref");

    const buttons = getAllByTag(activeView.root, "button").slice(0, 3);
    expect(buttons.map(accessibleName)).toEqual(["main", "Show all branches", "Refresh history"]);
    expect(buttons.map((button) => button.props.tabIndex)).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
    expect(buttons[1]?.textContent).toBe("");
    expect(buttons[1]?.props.title).toBe("Show all branches");
  });

  it("uses native button semantics for Space/Enter toggle and streams the ON/OFF scope", () => {
    activeView = new HistoryPanelView("ref");

    logStreamCalls.length = 0;
    nativeActivateToolbarButton(activeView, "Show all branches", " ");
    let toggle = buttonByName(activeView.root, "Show all branches");
    let call = lastLogStreamCall("Space toggles all branches on");
    expect(toggle.props["aria-pressed"]).toBe(true);
    expect(call.args.scope).toBe("all");
    expect(call.args.ref).toBeUndefined();

    logStreamCalls.length = 0;
    nativeActivateToolbarButton(activeView, "Show all branches", "Enter");
    toggle = buttonByName(activeView.root, "Show all branches");
    call = lastLogStreamCall("Enter toggles all branches off");
    expect(toggle.props["aria-pressed"]).toBe(false);
    expect(call.args.scope).toBe("ref");
    expect(call.args.ref).toBe("main");
  });
});

/** Installs the browser pieces touched by HistoryPanel hooks. */
function installDomGlobals(): void {
  windowTimers = new Map();
  nextTimerId = 0;
  (globalThis as unknown as { HTMLElement: typeof TestDomElement }).HTMLElement = TestDomElement;
  (globalThis as unknown as { document: Record<string, unknown> }).document = {
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  (globalThis as unknown as { window: Record<string, unknown> }).window = {
    innerWidth: 1024,
    addEventListener: () => {},
    removeEventListener: () => {},
    setTimeout: (callback: () => void) => {
      nextTimerId += 1;
      windowTimers.set(nextTimerId, callback);
      return nextTimerId;
    },
    clearTimeout: (id: number) => {
      windowTimers.delete(id);
    },
  };
}

/** Restores globals to avoid leaking the fake DOM to nearby component tests. */
function restoreDomGlobals(): void {
  if (originalWindow === undefined) {
    delete (globalThis as { window?: unknown }).window;
  } else {
    (globalThis as { window?: unknown }).window = originalWindow;
  }
  if (originalDocument === undefined) {
    delete (globalThis as { document?: unknown }).document;
  } else {
    (globalThis as { document?: unknown }).document = originalDocument;
  }
  if (originalHTMLElement === undefined) {
    delete (globalThis as { HTMLElement?: unknown }).HTMLElement;
  } else {
    (globalThis as { HTMLElement?: unknown }).HTMLElement = originalHTMLElement;
  }
}

/** Runs pending debounce timers synchronously. */
function drainWindowTimers(): void {
  const callbacks = [...windowTimers.values()];
  windowTimers.clear();
  for (const callback of callbacks) callback();
}

/** React node renderer for the limited host elements used in these tests. */
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

/** Applies function and object refs for fake DOM elements. */
function attachRef(refValue: unknown, element: TestDomElement): void {
  if (typeof refValue === "function") {
    refValue(element);
    return;
  }
  if (refValue && typeof refValue === "object" && "current" in refValue) {
    (refValue as { current: TestDomElement | null }).current = element;
  }
}

/** Runs one fake render pass under the test hook dispatcher. */
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

/** Compares dependency arrays with React's Object.is semantics. */
function dependenciesChanged(previous: DependencyList, next: DependencyList): boolean {
  if (previous === undefined || next === undefined) return true;
  if (previous.length !== next.length) return true;
  return previous.some((value, index) => !Object.is(value, next[index]));
}

/** Finds the live subtitle node. */
function liveRegion(root: TestDomElement): TestDomElement {
  const match = getAllByTag(root, "p").find((node) => node.props["aria-live"] === "polite");
  if (!match) throw new Error("Missing polite live-region subtitle");
  return match;
}

/** Finds the History search input. */
function searchInput(root: TestDomElement): TestDomElement {
  const match = getAllByTag(root, "input").find((node) => node.props.type === "search");
  if (!match) throw new Error("Missing history search input");
  return match;
}

/** Finds a button by accessible name. */
function buttonByName(root: TestDomElement, name: string): TestDomElement {
  const match = getAllByTag(root, "button").find((button) => accessibleName(button) === name);
  if (!match) throw new Error(`Missing button ${name}`);
  return match;
}

/** Collects all fake DOM elements by tag name. */
function getAllByTag(root: TestDomElement, tagName: string): TestDomElement[] {
  const matches: TestDomElement[] = [];
  visit(root, (node) => {
    if (node.type === tagName) matches.push(node);
  });
  return matches;
}

/** Depth-first traversal over fake DOM elements. */
function visit(root: TestDomElement, visitor: (node: TestDomElement) => void): void {
  visitor(root);
  for (const child of root.children) {
    if (child instanceof TestDomElement) visit(child, visitor);
  }
}

/** Returns the accessible name subset used by the toolbar buttons. */
function accessibleName(button: TestDomElement): string {
  return String(button.props["aria-label"] ?? button.textContent).trim();
}

/** Uses the native button activation path that browsers bind to Space and Enter. */
function nativeActivateToolbarButton(
  view: HistoryPanelView,
  name: string,
  key: " " | "Enter",
): void {
  const button = buttonByName(view.root, name);
  expect(button.type).toBe("button");
  expect(button.props.type).toBe("button");
  expect(button.props.onKeyDown).toBeUndefined();
  expect(key === " " || key === "Enter").toBe(true);
  callHandler(button.props.onClick, { currentTarget: button, target: button });
  view.render();
}

/** Invokes a captured React handler with a deliberately small event object. */
function callHandler(handler: unknown, event: unknown): void {
  if (typeof handler !== "function") throw new Error("Missing event handler");
  handler(event);
}

/** Returns the most recent git.log stream call, failing with scenario context when absent. */
function lastLogStreamCall(label: string): IpcStreamCall {
  const call = logStreamCalls
    .filter((entry) => entry.channel === "git" && entry.method === "log")
    .at(-1);
  if (!call) throw new Error(`Missing git.log stream call for ${label}`);
  return call;
}
