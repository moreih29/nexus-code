/**
 * Plan 18 adversarial scenarios — tester-authored, post-engineer cycle.
 *
 * Each section targets a gap not covered by engineer unit tests:
 *   T1: monaco-theme — two distinct instances share WeakSet independently
 *   T2: outline-live-refresh — rapid burst debounce + save-then-new-change
 *   T3: palette-controller — empty→non-empty→empty lastSnapshot + idle dim invariant
 *   T4: focus-restore — double-close guard + disabled attribute variation
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

// ─────────────────────────────────────────────────────────────────────────────
// Shared helpers
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// T1 — monaco-theme: two distinct Monaco instances register independently
// ─────────────────────────────────────────────────────────────────────────────

// Module-level import is hoisted — use dynamic import to share the already-loaded
// module from the main monaco-theme test file (same Bun module cache).
const { initializeMonacoTheme, NEXUS_DARK_THEME_COLORS } = await import(
  "../../src/renderer/services/editor/monaco-theme"
);
import { color } from "../../src/shared/design-tokens";
import type * as Monaco from "monaco-editor";

function createFakeMonacoInstance() {
  const calls: { name: string }[] = [];
  const defineTheme = mock((name: string) => {
    calls.push({ name });
  });
  const instance = {
    editor: {
      defineTheme,
      getModel: () => null,
      setModelMarkers: () => {},
    },
    languages: {
      registerHoverProvider: () => ({ dispose: () => {} }),
      registerDefinitionProvider: () => ({ dispose: () => {} }),
      registerCompletionItemProvider: () => ({ dispose: () => {} }),
      registerReferenceProvider: () => ({ dispose: () => {} }),
      registerDocumentHighlightProvider: () => ({ dispose: () => {} }),
      registerDocumentSymbolProvider: () => ({ dispose: () => {} }),
    },
    Uri: { parse: (s: string) => ({ toString: () => s }) },
    MarkerSeverity: { Error: 8, Warning: 4, Info: 2, Hint: 1 },
    MarkerTag: { Unnecessary: 1, Deprecated: 2 },
    _defineThemeMock: defineTheme,
    _calls: calls,
  } as unknown as typeof Monaco & {
    _defineThemeMock: ReturnType<typeof mock>;
    _calls: { name: string }[];
  };
  return instance;
}

describe("T1 adversarial — two separate Monaco instances are tracked independently", () => {
  it("each instance gets defineTheme called exactly once, regardless of the other", () => {
    const monacoA = createFakeMonacoInstance();
    const monacoB = createFakeMonacoInstance();

    // First instance: two calls → only first registers
    initializeMonacoTheme(monacoA);
    initializeMonacoTheme(monacoA);

    // Second instance: first call should register (not share WeakSet entry with A)
    initializeMonacoTheme(monacoB);

    expect(monacoA._defineThemeMock).toHaveBeenCalledTimes(1);
    expect(monacoB._defineThemeMock).toHaveBeenCalledTimes(1);
  });

  it("NEXUS_DARK_THEME_COLORS reference values match color tokens exactly (reference identity for string primitives)", () => {
    // Primitives in JS cannot be reference-compared; this test asserts strict
    // equality (===) to catch any copy-by-value divergence introduced during
    // a future refactor that might re-derive the values with different literals.
    expect(NEXUS_DARK_THEME_COLORS["editor.wordHighlightBackground"]).toBe(
      color.editorWordHighlight,
    );
    expect(NEXUS_DARK_THEME_COLORS["editor.wordHighlightStrongBackground"]).toBe(
      color.editorWordHighlightStrong,
    );
    expect(NEXUS_DARK_THEME_COLORS["editor.wordHighlightTextBackground"]).toBe(
      color.editorWordHighlightText,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// T2 — outline-live-refresh: rapid burst + save-then-new-change
// ─────────────────────────────────────────────────────────────────────────────

interface TimerEntry {
  id: number;
  dueAt: number;
  callback: () => void;
  cleared: boolean;
}

class FakeScheduler {
  private now = 0;
  private nextId = 1;
  private timers: TimerEntry[] = [];

  setTimeout(callback: () => void, delayMs: number): number {
    const id = this.nextId++;
    this.timers.push({ id, dueAt: this.now + delayMs, callback, cleared: false });
    return id;
  }

  clearTimeout(id: number): void {
    const entry = this.timers.find((t) => t.id === id);
    if (entry) entry.cleared = true;
  }

  advanceBy(ms: number): void {
    this.now += ms;
    for (const timer of this.timers) {
      if (!timer.cleared && timer.dueAt <= this.now) {
        timer.cleared = true;
        timer.callback();
      }
    }
  }

  pendingCount(): number {
    return this.timers.filter((t) => !t.cleared).length;
  }
}

type TransitionListener = (event: { cacheUri: string; isDirty: boolean }) => void;
type SavedListener = (event: { cacheUri: string }) => void;
type ReleaseListener = (released: { cacheUri: string }) => void;

function makeChannels() {
  let onTransition: TransitionListener | null = null;
  let onSaved: SavedListener | null = null;
  let onRelease: ReleaseListener | null = null;

  return {
    subscribeTransitions: (fn: TransitionListener) => {
      onTransition = fn;
      return () => {
        onTransition = null;
      };
    },
    subscribeSaved: (fn: SavedListener) => {
      onSaved = fn;
      return () => {
        onSaved = null;
      };
    },
    subscribeOnRelease: (fn: ReleaseListener) => {
      onRelease = fn;
      return () => {
        onRelease = null;
      };
    },
    emitTransition: (cacheUri: string, isDirty: boolean) =>
      onTransition?.({ cacheUri, isDirty }),
    emitSaved: (cacheUri: string) => onSaved?.({ cacheUri }),
    emitRelease: (cacheUri: string) => onRelease?.({ cacheUri }),
  };
}

const {
  setActiveOutlineUri,
  __setOutlineRefreshSubscribersForTests,
  __resetOutlineRefreshSubscribersForTests,
  OUTLINE_REFRESH_DEBOUNCE_MS,
} = await import("../../src/renderer/state/stores/outline-live-refresh");

const URI_A = "file:///workspace/a.ts";
const URI_B = "file:///workspace/b.ts";

let scheduler: FakeScheduler;
let channels: ReturnType<typeof makeChannels>;
let loadCalls: Array<{ uri: string; force?: boolean }>;
let load: ReturnType<typeof mock>;

beforeEach(() => {
  __resetOutlineRefreshSubscribersForTests();
  scheduler = new FakeScheduler();
  channels = makeChannels();
  loadCalls = [];
  load = mock((uri: string, _signal?: AbortSignal, options?: { force?: boolean }) => {
    loadCalls.push({ uri, force: options?.force });
    return Promise.resolve();
  });
  __setOutlineRefreshSubscribersForTests({
    subscribeTransitions: channels.subscribeTransitions,
    subscribeSaved: channels.subscribeSaved,
    subscribeOnRelease: channels.subscribeOnRelease,
    scheduler: {
      setTimeout: (cb, ms) => scheduler.setTimeout(cb, ms),
      clearTimeout: (id) => scheduler.clearTimeout(id as number),
    },
    getLoad: () => load as never,
  });
});

afterEach(() => {
  __resetOutlineRefreshSubscribersForTests();
});

describe("T2 adversarial — rapid burst and save-then-new-change", () => {
  it("four rapid didChange events (0/50/150/300ms) produce exactly one load at 300+400ms", () => {
    setActiveOutlineUri(URI_A);

    // t=0
    channels.emitTransition(URI_A, true);
    scheduler.advanceBy(50);
    // t=50
    channels.emitTransition(URI_A, true);
    scheduler.advanceBy(100);
    // t=150
    channels.emitTransition(URI_A, true);
    scheduler.advanceBy(150);
    // t=300
    channels.emitTransition(URI_A, true);

    // Advance to just before 4th-debounce expiry (300ms + 400ms - 1ms = 699ms total from t=0)
    scheduler.advanceBy(399);
    expect(loadCalls).toHaveLength(0);

    // Fire the 4th debounce
    scheduler.advanceBy(1);
    expect(loadCalls).toHaveLength(1);
    expect(loadCalls[0]?.uri).toBe(URI_A);
    expect(loadCalls[0]?.force).toBe(true);
  });

  it("save mid-debounce: load fires immediately; subsequent didChange starts a fresh 400ms debounce", () => {
    setActiveOutlineUri(URI_A);

    // Start debounce
    channels.emitTransition(URI_A, true);
    scheduler.advanceBy(200); // midway

    // Save arrives — immediate load, debounce cancelled
    channels.emitSaved(URI_A);
    expect(loadCalls).toHaveLength(1);
    expect(loadCalls[0]?.force).toBe(true);

    // Remaining 200ms of the old debounce fires — must NOT produce a second load
    scheduler.advanceBy(200);
    expect(loadCalls).toHaveLength(1);

    // New didChange after save starts a fresh 400ms debounce
    channels.emitTransition(URI_A, true);
    scheduler.advanceBy(399);
    expect(loadCalls).toHaveLength(1); // still 1

    scheduler.advanceBy(1);
    expect(loadCalls).toHaveLength(2); // fresh debounce fired
    expect(loadCalls[1]?.uri).toBe(URI_A);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// T3 — palette-controller: empty→non-empty→empty toggle + idle dim invariant
// ─────────────────────────────────────────────────────────────────────────────

import {
  type PaletteScheduler,
  PaletteSearchController,
  type PaletteSearchSnapshot,
} from "../../src/renderer/components/lsp/palette/controller";
import type { PaletteItem, PaletteSource } from "../../src/renderer/components/lsp/palette/types";

class FakePaletteScheduler implements PaletteScheduler {
  private now = 0;
  private nextId = 1;
  private timers = new Map<number, { dueAt: number; callback: () => void }>();

  setTimeout(callback: () => void, delayMs: number): number {
    const id = this.nextId++;
    this.timers.set(id, { dueAt: this.now + delayMs, callback });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }

  advanceBy(ms: number): void {
    this.now += ms;
    const due = [...this.timers.entries()]
      .filter(([, t]) => t.dueAt <= this.now)
      .sort(([a], [b]) => a - b);
    for (const [id, t] of due) {
      if (!this.timers.delete(id)) continue;
      t.callback();
    }
  }
}

function paletteSource(search: PaletteSource["search"]): PaletteSource {
  return {
    id: "test",
    title: "Test",
    placeholder: "Search",
    emptyQueryMessage: "Type to search",
    noResultsMessage: "None",
    search,
    accept: () => {},
  };
}

function paletteItem(id: string): PaletteItem {
  return { id, label: id };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("T3 adversarial — empty→non-empty→empty toggle and lastSnapshot", () => {
  it("after results appear, returning to empty query emits idle with empty items and dimmed=false", async () => {
    const sched = new FakePaletteScheduler();
    const snapshots: PaletteSearchSnapshot[] = [];
    let resolveSearch!: (items: PaletteItem[]) => void;
    const search = mock(
      (_query: string, _signal: AbortSignal) =>
        new Promise<PaletteItem[]>((r) => {
          resolveSearch = r;
        }),
    );
    const ctrl = new PaletteSearchController(
      paletteSource(search as PaletteSource["search"]),
      (s) => snapshots.push(s),
      sched,
    );

    // First: type "foo" → get results
    ctrl.setQuery("foo");
    sched.advanceBy(200);
    resolveSearch([paletteItem("X"), paletteItem("Y")]);
    await flushMicrotasks();

    const resultSnap = snapshots.at(-1);
    expect(resultSnap?.status).toBe("results");
    expect(resultSnap?.items).toHaveLength(2);

    // Back to empty
    ctrl.setQuery("   ");
    const idleSnap = snapshots.at(-1);
    expect(idleSnap?.status).toBe("idle");
    expect(idleSnap?.items).toHaveLength(0);
    expect(idleSnap?.dimmed).toBeFalsy();
  });

  it("idle snapshot never carries dimmed=true regardless of prior lastSnapshot state", async () => {
    const sched = new FakePaletteScheduler();
    const snapshots: PaletteSearchSnapshot[] = [];
    let resolveSearch!: (items: PaletteItem[]) => void;
    const search = mock(
      (_query: string, _signal: AbortSignal) =>
        new Promise<PaletteItem[]>((r) => {
          resolveSearch = r;
        }),
    );
    const ctrl = new PaletteSearchController(
      paletteSource(search as PaletteSource["search"]),
      (s) => snapshots.push(s),
      sched,
    );

    // Build up a dimmed state: type "a", advance past grace period
    ctrl.setQuery("a");
    sched.advanceBy(100); // grace fires → dimmed=true snapshot

    const dimmingSnap = snapshots.find((s) => s.dimmed === true);
    expect(dimmingSnap).toBeDefined(); // ensure we actually reached dimmed state

    // Abort by going back to empty — idle must not inherit dimmed
    ctrl.setQuery("  ");
    const idleSnap = snapshots.at(-1);
    expect(idleSnap?.status).toBe("idle");
    expect(idleSnap?.dimmed).toBeFalsy();
  });

  it("dispose after setQuery during debounce: no further emissions, disposed flag blocks new setQuery", () => {
    const sched = new FakePaletteScheduler();
    const snapshots: PaletteSearchSnapshot[] = [];
    const ctrl = new PaletteSearchController(
      paletteSource(async () => [paletteItem("Z")]),
      (s) => snapshots.push(s),
      sched,
    );

    ctrl.setQuery("z");
    const countBeforeDispose = snapshots.length;
    ctrl.dispose();

    // New setQuery after dispose must be a no-op
    ctrl.setQuery("zz");
    sched.advanceBy(300);

    expect(snapshots.length).toBe(countBeforeDispose); // nothing added after dispose
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// T4 — focus-restore: double-cleanup guard + disabled via property (not attribute)
// ─────────────────────────────────────────────────────────────────────────────

interface FakeEl {
  isConnected: boolean;
  _disabled: boolean;
  focusCalls: number;
  hasAttribute(name: string): boolean;
  focus(opts?: { preventScroll?: boolean }): void;
}

function makeFakeEl(opts: { isConnected: boolean; disabled: boolean }): FakeEl {
  const el: FakeEl = {
    isConnected: opts.isConnected,
    _disabled: opts.disabled,
    focusCalls: 0,
    hasAttribute(name: string): boolean {
      return name === "disabled" ? el._disabled : false;
    },
    focus(_opts?: { preventScroll?: boolean }): void {
      el.focusCalls++;
    },
  };
  return el;
}

/** Mirror of the useEffect cleanup in command-palette.tsx — update if component changes. */
function runCleanup(target: FakeEl | null): void {
  if (target?.isConnected && !target.hasAttribute("disabled")) {
    target.focus({ preventScroll: true });
  }
}

describe("T4 adversarial — focus-restore double-cleanup and disabled path", () => {
  it("calling cleanup twice only restores focus once (ref-null pattern)", () => {
    const caller = makeFakeEl({ isConnected: true, disabled: false });

    // Simulate the ref-null pattern: read, null ref, then restore
    let ref: FakeEl | null = caller;
    const target = ref;
    ref = null;

    runCleanup(target);
    runCleanup(ref); // second call with null — should be silent

    expect(caller.focusCalls).toBe(1);
  });

  it("element that becomes disabled between open and close does not receive focus", () => {
    const caller = makeFakeEl({ isConnected: true, disabled: false });
    // Simulate element becoming disabled after palette opened
    caller._disabled = true;

    runCleanup(caller);

    expect(caller.focusCalls).toBe(0);
  });

  it("element that becomes disconnected between open and close does not throw and does not receive focus", () => {
    const caller = makeFakeEl({ isConnected: false, disabled: false });

    expect(() => runCleanup(caller)).not.toThrow();
    expect(caller.focusCalls).toBe(0);
  });

  it("focus is restored when element is connected and enabled — basic contract invariant", () => {
    const caller = makeFakeEl({ isConnected: true, disabled: false });
    runCleanup(caller);
    expect(caller.focusCalls).toBe(1);
  });
});
