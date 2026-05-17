/**
 * Scenario verification for History streaming, selection wiring, and auto-refresh.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { ReactElement, ReactNode } from "react";
import * as React from "react";
import type { LogEntry } from "../../../../../../../src/shared/git/types";

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
const openCommitCalls: Array<{ workspaceId: string; sha: string }> = [];
let lastHistoryListProps: MockHistoryListProps | null = null;

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

mock.module("../../../../../../../src/renderer/ipc/client", () => ({
  ipcCall: ipcCallMock,
  ipcListen: mock(() => () => {}),
  ipcStream: ipcStreamMock,
}));

mock.module("../../../../../../../src/renderer/state/stores/git", () => ({
  useGitStore: (selector: (state: MockGitStoreState) => unknown) => selector(mockGitStoreState),
}));

mock.module("../../../../../../../src/renderer/state/operations/tabs", () => ({
  openOrRevealCommitTab: mock((workspaceId: string, sha: string) => {
    openCommitCalls.push({ workspaceId, sha });
    return { groupId: "group-1", tabId: "tab-1" };
  }),
}));

mock.module("../../../../../../../src/renderer/components/files/git/history/ref-switcher", () => ({
  HistoryRefSwitcher: () => null,
}));

mock.module("../../../../../../../src/renderer/components/files/git/history/list", () => ({
  HistoryList: (props: MockHistoryListProps) => {
    lastHistoryListProps = props;
    return React.createElement("section", { "aria-label": "mock history list" });
  },
}));

const realCommitMenu = await import(
  "../../../../../../../src/renderer/components/files/git/history/commit-menu"
);

mock.module(
  "../../../../../../../src/renderer/components/files/git/history/commit-menu",
  () => ({
    ...realCommitMenu,
    HistoryCommitMenu: () => null,
  }),
);

mock.module("../../../../../../../src/renderer/components/files/git/history/ref-chip", () => ({
  RefChipList: () => null,
}));

const { HistoryPanel } = await import(
  "../../../../../../../src/renderer/components/files/git/history/panel"
);

type MockBranchInfo = {
  current: string;
  upstream: string | null;
  ahead: number;
  behind: number;
  isUnborn: boolean;
};

type MockGitSession = {
  branchInfo: MockBranchInfo | null;
};

type MockGitStoreState = {
  cherryPick: () => Promise<boolean>;
  checkoutDetached: () => Promise<void>;
  resetSoft: () => Promise<void>;
  // HistoryPanel subscribes to branchInfo via state.sessions.get(workspaceId)
  // to auto-refresh after branch transitions; tests mutate the map to
  // simulate `git checkout`-like transitions across renders.
  sessions: Map<string, MockGitSession>;
};

function branchInfoFor(current: string): MockBranchInfo {
  return {
    current,
    upstream: null,
    ahead: 0,
    behind: 0,
    isUnborn: false,
  };
}

type MockHistoryListProps = {
  selectedSha: string | null;
  onSelect: (entry: LogEntry) => void;
  onOpen: (entry: LogEntry) => void;
};

const mockGitStoreState: MockGitStoreState = {
  cherryPick: async () => true,
  checkoutDetached: async () => {},
  resetSoft: async () => {},
  sessions: new Map(),
};

type EffectCallback = () => undefined | (() => void);
type DependencyList = readonly unknown[] | undefined;

type ReactDispatcher = {
  useCallback: <T extends (...args: never[]) => unknown>(callback: T, deps?: DependencyList) => T;
  useEffect: (callback: EffectCallback, deps?: DependencyList) => void;
  useId: () => string;
  useInsertionEffect: (callback: EffectCallback, deps?: DependencyList) => void;
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
    useId: () => {
      const slot = this.cursor;
      this.cursor += 1;
      if (!(slot in this.hookValues)) this.hookValues[slot] = `:r${slot}:`;
      return this.hookValues[slot] as string;
    },
    useInsertionEffect: (callback, deps) => this.queueEffect(callback, deps),
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

/** Controlled wrapper that plays the parent GitPanel role for ref props. */
class HistoryPanelView {
  private readonly harness = new HookHarness();
  refName = "main";
  root: TestDomElement;

  constructor() {
    this.root = this.render();
  }

  render(): TestDomElement {
    this.root = this.harness.render(
      React.createElement(HistoryPanel, {
        workspaceId: WORKSPACE_ID,
        refName: this.refName,
        onRefChange: (nextRefName: string) => {
          this.refName = nextRefName;
        },
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
  openCommitCalls.length = 0;
  lastHistoryListProps = null;
  ipcCallMock.mockClear();
  ipcStreamMock.mockClear();
  installDomGlobals();
});

afterEach(() => {
  activeView?.cleanup();
  activeView = null;
  restoreDomGlobals();
});

describe("HistoryPanel streaming", () => {
  it("keeps selection separate from explicit main-area commit tab opens", () => {
    activeView = new HistoryPanelView();
    const firstEntry = makeLogEntry(1);
    const secondEntry = makeLogEntry(2);

    const firstListProps = currentHistoryListProps();
    firstListProps.onSelect(firstEntry);
    activeView.render();

    expect(currentHistoryListProps().selectedSha).toBe(firstEntry.sha);
    expect(openCommitCalls).toEqual([]);
    expect(ipcCallRecords.filter((record) => record.method === "commitDetail")).toEqual([]);

    currentHistoryListProps().onOpen(secondEntry);
    activeView.render();

    expect(currentHistoryListProps().selectedSha).toBe(secondEntry.sha);
    expect(openCommitCalls).toEqual([{ workspaceId: WORKSPACE_ID, sha: secondEntry.sha }]);
    expect(ipcCallRecords.filter((record) => record.method === "commitDetail")).toEqual([]);
  });

  it("re-streams the first page when the workspace branch transitions", () => {
    // Seed branch state before mount so the first observation is "main".
    mockGitStoreState.sessions.set(WORKSPACE_ID, {
      branchInfo: branchInfoFor("main"),
    });
    activeView = new HistoryPanelView();
    // The mount triggers the initial first-page stream. Clear the recorded
    // calls so we only assert the auto-refresh-driven re-stream below.
    expect(lastLogStreamCall("mount streams first page").args.ref).toBe("main");
    logStreamCalls.length = 0;

    // Simulate `git checkout dev`: the store now reports dev as current.
    mockGitStoreState.sessions.set(WORKSPACE_ID, {
      branchInfo: branchInfoFor("dev"),
    });
    activeView.render();

    const call = lastLogStreamCall("branch change re-streams first page");
    expect(call.channel).toBe("git");
    expect(call.method).toBe("log");
    expect(call.args.workspaceId).toBe(WORKSPACE_ID);
    expect(call.args.scope).toBe("ref");
    // refName prop is still "main" (user's explicit selection is unchanged);
    // auto-refresh re-streams the current view rather than overriding it.
    expect(call.args.ref).toBe("main");

    // Re-rendering with the same signature must not enqueue another stream.
    logStreamCalls.length = 0;
    activeView.render();
    expect(logStreamCalls).toHaveLength(0);
  });

  it("does not auto-refresh while a search query is active", () => {
    mockGitStoreState.sessions.set(WORKSPACE_ID, {
      branchInfo: branchInfoFor("main"),
    });
    activeView = new HistoryPanelView();
    activeView.typeSearch("fix popover");
    activeView.drainDebounceTimers();
    logStreamCalls.length = 0;

    // Branch transition mid-search: keep the search intact rather than
    // snapping back to head history.
    mockGitStoreState.sessions.set(WORKSPACE_ID, {
      branchInfo: branchInfoFor("dev"),
    });
    activeView.render();

    expect(logStreamCalls).toHaveLength(0);
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
  // Use the setter (not delete) so the matchMedia-injecting window accessor
  // installed by tests/setup.ts is not removed from globalThis.
  (globalThis as Record<string, unknown>).window = originalWindow;
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

/** Finds the History search input. */
function searchInput(root: TestDomElement): TestDomElement {
  const match = getAllByTag(root, "input").find((node) => node.props.type === "search");
  if (!match) throw new Error("Missing history search input");
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

/** Returns the props captured by the HistoryList mock for panel wiring assertions. */
function currentHistoryListProps(): MockHistoryListProps {
  if (!lastHistoryListProps) throw new Error("HistoryList was not rendered");
  return lastHistoryListProps;
}

/** Builds one deterministic commit entry for selection/open wiring tests. */
function makeLogEntry(index: number): LogEntry {
  return {
    sha: index.toString(16).padStart(40, "0"),
    shortSha: `s${String(index).padStart(6, "0")}`,
    parents: [],
    authorName: `Author ${index}`,
    authorEmail: `author-${index}@example.invalid`,
    authoredAt: "2026-05-10T00:00:00.000Z",
    subject: `Commit ${index}`,
    body: "",
    refs: [],
  };
}
