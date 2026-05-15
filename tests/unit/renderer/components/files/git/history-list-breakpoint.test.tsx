/**
 * Scenario regression tests for HistoryList container-width breakpoints.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { ReactElement, ReactNode } from "react";
import * as React from "react";
import type { HistoryListBreakpoint } from "../../../../../../src/renderer/components/files/git/history/list";
import {
  HISTORY_LIST_BREAKPOINT_MEDIUM,
  HISTORY_LIST_BREAKPOINT_NARROW,
  useHistoryListBreakpoint,
} from "../../../../../../src/renderer/components/files/git/history/list";

type DependencyList = readonly unknown[] | undefined;
type EffectCallback = () => undefined | (() => void);

type ReactDispatcher = {
  useEffect: (callback: EffectCallback, deps?: DependencyList) => void;
  useRef: <T>(initialValue: T) => { current: T };
  useState: <T>(initialValue: T | (() => T)) => [T, (next: T | ((current: T) => T)) => void];
};

type EffectRecord = {
  kind: "effect";
  deps: DependencyList;
  cleanup?: () => void;
};

type PendingEffect = {
  slot: number;
  callback: EffectCallback;
};

type TestNode = TestDomElement | TestTextNode;

/** Minimal element used as both observed container and rendered output. */
class TestDomElement {
  readonly children: TestNode[] = [];
  parent: TestDomElement | null = null;
  width = 400;

  constructor(
    readonly type: string,
    readonly props: Record<string, unknown>,
  ) {}

  append(child: TestNode): void {
    child.parent = this;
    this.children.push(child);
  }

  getBoundingClientRect(): DOMRect {
    return {
      x: 0,
      y: 0,
      width: this.width,
      height: 24,
      top: 0,
      left: 0,
      right: this.width,
      bottom: 24,
      toJSON: () => ({}),
    } as DOMRect;
  }
}

/** Text nodes are retained only so the fake renderer can traverse children uniformly. */
class TestTextNode {
  parent: TestDomElement | null = null;

  constructor(readonly value: string) {}
}

/** ResizeObserver test double with explicit width emission. */
class ResizeObserverHarness {
  static latest: ResizeObserverHarness | null = null;

  observed: TestDomElement | null = null;
  disconnected = false;

  constructor(private readonly callback: ResizeObserverCallback) {
    ResizeObserverHarness.latest = this;
  }

  observe(target: Element): void {
    this.observed = target as unknown as TestDomElement;
  }

  disconnect(): void {
    this.disconnected = true;
  }

  emit(width: number): void {
    if (this.observed) this.observed.width = width;
    this.callback(
      [
        {
          contentRect: { width },
        } as ResizeObserverEntry,
      ],
      this as unknown as ResizeObserver,
    );
  }
}

/** Hook dispatcher with dependency-aware effects for the breakpoint hook. */
class HookHarness {
  private readonly hookValues: unknown[] = [];
  private cursor = 0;
  private readonly pendingEffects: PendingEffect[] = [];

  readonly dispatcher: ReactDispatcher = {
    useEffect: (callback, deps) => this.queueEffect(callback, deps),
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
        this.hookValues[slot] = resolved;
      };
      return [this.hookValues[slot] as never, setState as never];
    },
  };

  render(element: ReactElement): TestDomElement {
    this.cursor = 0;
    this.pendingEffects.length = 0;
    const roots = withReactDispatcher(this.dispatcher, () => renderReactNode(element));
    this.runPendingEffects();
    const root = roots.find((node): node is TestDomElement => node instanceof TestDomElement);
    if (!root) throw new Error("breakpoint probe rendered no element");
    return root;
  }

  cleanup(): void {
    for (const value of this.hookValues) {
      if (isEffectRecord(value)) value.cleanup?.();
    }
  }

  private queueEffect(callback: EffectCallback, deps: DependencyList): void {
    const slot = this.cursor;
    this.cursor += 1;
    const previous = this.hookValues[slot];
    if (isEffectRecord(previous) && !dependenciesChanged(previous.deps, deps)) return;
    if (isEffectRecord(previous)) previous.cleanup?.();
    this.hookValues[slot] = { kind: "effect", deps } satisfies EffectRecord;
    this.pendingEffects.push({ slot, callback });
  }

  private runPendingEffects(): void {
    for (const effect of this.pendingEffects) {
      const cleanup = effect.callback();
      const record = this.hookValues[effect.slot];
      if (isEffectRecord(record)) record.cleanup = cleanup;
    }
  }
}

/** Stateful probe view for re-rendering after debounced observer updates. */
class BreakpointProbeView {
  private readonly harness = new HookHarness();
  root: TestDomElement;

  constructor(private readonly refObject: React.RefObject<HTMLElement | null>) {
    this.root = this.render();
    activeHarnesses.push(this.harness);
  }

  render(): TestDomElement {
    this.root = this.harness.render(
      React.createElement(BreakpointProbe, { scrollRef: this.refObject }),
    );
    return this.root;
  }

  breakpoint(): HistoryListBreakpoint {
    return this.root.props["data-breakpoint"] as HistoryListBreakpoint;
  }
}

const originalResizeObserver = (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
const activeHarnesses: HookHarness[] = [];

beforeEach(() => {
  ResizeObserverHarness.latest = null;
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver =
    ResizeObserverHarness as unknown as typeof ResizeObserver;
});

afterEach(() => {
  for (const harness of activeHarnesses) harness.cleanup();
  activeHarnesses.length = 0;
  ResizeObserverHarness.latest = null;
  if (originalResizeObserver === undefined) {
    delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
  } else {
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = originalResizeObserver;
  }
});

describe("useHistoryListBreakpoint", () => {
  it("starts medium and debounces the 320px/480px breakpoint boundaries", async () => {
    const view = renderBreakpointProbe(400);

    expect(view.breakpoint()).toBe("medium");

    await emitWidthAndRender(view, HISTORY_LIST_BREAKPOINT_NARROW - 1);
    expect(view.breakpoint()).toBe("narrow");

    await emitWidthAndRender(view, HISTORY_LIST_BREAKPOINT_NARROW);
    expect(view.breakpoint()).toBe("medium");

    await emitWidthAndRender(view, HISTORY_LIST_BREAKPOINT_MEDIUM - 1);
    expect(view.breakpoint()).toBe("medium");

    await emitWidthAndRender(view, HISTORY_LIST_BREAKPOINT_MEDIUM);
    expect(view.breakpoint()).toBe("wide");
  });

  it("keeps the previous breakpoint when hidden width is reported as zero", async () => {
    const view = renderBreakpointProbe(500);

    await emitWidthAndRender(view, 500);
    expect(view.breakpoint()).toBe("wide");

    await emitWidthAndRender(view, 0);
    expect(view.breakpoint()).toBe("wide");
  });

  it("attaches after the scroll ref becomes available on a later render", async () => {
    const refObject = { current: null as HTMLElement | null };
    const view = new BreakpointProbeView(refObject);

    expect(ResizeObserverHarness.latest).toBeNull();

    refObject.current = observedElement(500);
    view.render();

    expect(ResizeObserverHarness.latest).not.toBeNull();
    await emitWidthAndRender(view, 500);
    expect(view.breakpoint()).toBe("wide");
  });
});

/** Component under test that exposes the hook result through test-friendly props. */
function BreakpointProbe({ scrollRef }: { scrollRef: React.RefObject<HTMLElement | null> }) {
  const breakpoint = useHistoryListBreakpoint(scrollRef);
  return <output data-breakpoint={breakpoint} />;
}

/** Creates a hook probe with a fixed observed container element. */
function renderBreakpointProbe(width: number): BreakpointProbeView {
  return new BreakpointProbeView({ current: observedElement(width) });
}

/** Creates an observed HTMLElement stand-in with the requested bounding width. */
function observedElement(width: number): HTMLElement {
  const scrollElement = new TestDomElement("div", {}) as unknown as HTMLElement;
  (scrollElement as unknown as TestDomElement).width = width;
  return scrollElement;
}

/** Emits one observer width, waits for the 100ms debounce, then re-renders. */
async function emitWidthAndRender(view: BreakpointProbeView, width: number): Promise<void> {
  const observer = ResizeObserverHarness.latest;
  if (!observer) throw new Error("ResizeObserver was not attached");
  observer.emit(width);
  await sleep(110);
  view.render();
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
  return [element];
}

/** Narrows arbitrary React nodes to element records. */
function isReactElement(node: ReactNode): node is ReactElement<Record<string, unknown>> {
  return typeof node === "object" && node !== null && "type" in node && "props" in node;
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

/** Identifies effect records among mixed hook slots. */
function isEffectRecord(value: unknown): value is EffectRecord {
  return typeof value === "object" && value !== null && (value as EffectRecord).kind === "effect";
}

/** React-like dependency comparison for effect reruns. */
function dependenciesChanged(left: DependencyList, right: DependencyList): boolean {
  if (!left || !right) return true;
  if (left.length !== right.length) return true;
  return left.some((value, index) => !Object.is(value, right[index]));
}

/** Waits for the hook debounce to expire without depending on fake timers. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
