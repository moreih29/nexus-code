import { describe, expect, it, mock } from "bun:test";
import {
  nextPaletteIndex,
  type PaletteScheduler,
  PaletteSearchController,
  type PaletteSearchSnapshot,
  resolvePaletteKeyAction,
  WORKSPACE_SYMBOL_DEBOUNCE_MS,
} from "../../../../../../src/renderer/components/lsp/palette/controller";
import type {
  PaletteItem,
  PaletteSource,
} from "../../../../../../src/renderer/components/lsp/palette/types";

interface TimerEntry {
  id: number;
  dueAt: number;
  callback: () => void;
}

class FakeScheduler implements PaletteScheduler {
  private now = 0;
  private nextId = 1;
  private timers = new Map<number, TimerEntry>();

  setTimeout(callback: () => void, delayMs: number): number {
    const id = this.nextId;
    this.nextId += 1;
    this.timers.set(id, { id, dueAt: this.now + delayMs, callback });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }

  advanceBy(ms: number): void {
    this.now += ms;
    const due = [...this.timers.values()]
      .filter((timer) => timer.dueAt <= this.now)
      .sort((a, b) => a.dueAt - b.dueAt || a.id - b.id);
    for (const timer of due) {
      if (!this.timers.delete(timer.id)) continue;
      timer.callback();
    }
  }
}

function item(id: string): PaletteItem {
  return { id, label: id };
}

function source(search: PaletteSource["search"]): PaletteSource {
  return {
    id: "test",
    title: "Test",
    placeholder: "Search",
    emptyQueryMessage: "Type",
    noResultsMessage: "None",
    search,
    accept: () => {},
  };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("PaletteSearchController", () => {
  it("debounces search by 200ms with fake timers", async () => {
    const scheduler = new FakeScheduler();
    const search = mock(async () => [item("Greet")]);
    const snapshots: PaletteSearchSnapshot[] = [];
    const controller = new PaletteSearchController(
      source(search),
      (snapshot) => snapshots.push(snapshot),
      scheduler,
    );

    controller.setQuery("Gre");
    scheduler.advanceBy(WORKSPACE_SYMBOL_DEBOUNCE_MS - 1);
    expect(search).not.toHaveBeenCalled();

    scheduler.advanceBy(1);
    expect(search).toHaveBeenCalledTimes(1);
    await flushMicrotasks();

    expect(snapshots.map((snapshot) => snapshot.status)).toEqual([
      "debouncing",
      "debouncing",
      "loading",
      "results",
    ]);
  });

  it("aborts the in-flight search when a new query starts", async () => {
    const scheduler = new FakeScheduler();
    const signals: AbortSignal[] = [];
    const search = mock((async (_query: string, signal: AbortSignal) => {
      signals.push(signal);
      return new Promise<PaletteItem[]>(() => {});
    }) satisfies PaletteSource["search"]);
    const controller = new PaletteSearchController(source(search), () => {}, scheduler);

    controller.setQuery("Gre");
    scheduler.advanceBy(WORKSPACE_SYMBOL_DEBOUNCE_MS);
    expect(signals[0]?.aborted).toBe(false);

    controller.setQuery("Greet");
    expect(signals[0]?.aborted).toBe(true);
  });

  it("does not call the source for empty queries", () => {
    const scheduler = new FakeScheduler();
    const search = mock(async () => [item("Greet")]);
    const snapshots: PaletteSearchSnapshot[] = [];
    const controller = new PaletteSearchController(
      source(search),
      (snapshot) => snapshots.push(snapshot),
      scheduler,
    );

    controller.setQuery("   ");
    scheduler.advanceBy(WORKSPACE_SYMBOL_DEBOUNCE_MS);

    expect(search).not.toHaveBeenCalled();
    expect(snapshots.at(-1)?.status).toBe("idle");
  });
});

describe("stale-list dim behavior", () => {
  it("empty query emits idle with empty items and no dimmed flag", () => {
    const scheduler = new FakeScheduler();
    const snapshots: PaletteSearchSnapshot[] = [];
    const controller = new PaletteSearchController(
      source(async () => []),
      (snapshot) => snapshots.push(snapshot),
      scheduler,
    );

    controller.setQuery("   ");
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.status).toBe("idle");
    expect(snapshots[0]?.items).toHaveLength(0);
    expect(snapshots[0]?.dimmed).toBeFalsy();
  });

  it("first search with no prior items: debouncing dimmed=false, then dimmed=true after 100ms", () => {
    const scheduler = new FakeScheduler();
    const snapshots: PaletteSearchSnapshot[] = [];
    const controller = new PaletteSearchController(
      source(async () => new Promise(() => {})),
      (snapshot) => snapshots.push(snapshot),
      scheduler,
    );

    controller.setQuery("a");
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.status).toBe("debouncing");
    expect(snapshots[0]?.dimmed).toBe(false);
    expect(snapshots[0]?.items).toHaveLength(0);

    scheduler.advanceBy(100);
    expect(snapshots).toHaveLength(2);
    expect(snapshots[1]?.status).toBe("debouncing");
    expect(snapshots[1]?.dimmed).toBe(true);
    expect(snapshots[1]?.items).toHaveLength(0);
  });

  it("second search preserves prior items in debouncing and loading, clears on results", async () => {
    const scheduler = new FakeScheduler();
    const snapshots: PaletteSearchSnapshot[] = [];
    const firstItems = [item("Alpha"), item("Beta")];
    let resolveSearch: (items: PaletteItem[]) => void = () => {};
    const search = mock(
      (_query: string, _signal: AbortSignal) =>
        new Promise<PaletteItem[]>((resolve) => {
          resolveSearch = resolve;
        }),
    );
    const controller = new PaletteSearchController(
      source(search as PaletteSource["search"]),
      (snapshot) => snapshots.push(snapshot),
      scheduler,
    );

    // First search: complete successfully
    controller.setQuery("a");
    scheduler.advanceBy(200);
    resolveSearch(firstItems);
    await flushMicrotasks();

    const firstResultsIdx = snapshots.findIndex((s) => s.status === "results");
    expect(firstResultsIdx).toBeGreaterThanOrEqual(0);
    expect(snapshots[firstResultsIdx]?.items).toHaveLength(2);
    expect(snapshots[firstResultsIdx]?.dimmed).toBe(false);

    const snapshotCountAfterFirst = snapshots.length;

    // Second search: debouncing should preserve prior items
    controller.setQuery("ab");
    const debouncingSnap = snapshots[snapshotCountAfterFirst];
    expect(debouncingSnap?.status).toBe("debouncing");
    expect(debouncingSnap?.dimmed).toBe(false);
    expect(debouncingSnap?.items).toHaveLength(2);

    // After 100ms grace: dimmed=true with prior items
    scheduler.advanceBy(100);
    const graceSnap = snapshots[snapshotCountAfterFirst + 1];
    expect(graceSnap?.status).toBe("debouncing");
    expect(graceSnap?.dimmed).toBe(true);
    expect(graceSnap?.items).toHaveLength(2);

    // After debounce fires: loading with prior items, dimmed=true
    scheduler.advanceBy(100);
    const loadingSnaps = snapshots.filter((s) => s.status === "loading");
    const secondLoadingSnap = loadingSnaps.at(-1);
    expect(secondLoadingSnap?.dimmed).toBe(true);
    expect(secondLoadingSnap?.items).toHaveLength(2);

    // Resolve with new items: dimmed=false
    const newItems = [item("Zeta")];
    resolveSearch(newItems);
    await flushMicrotasks();
    const finalSnap = snapshots.at(-1);
    expect(finalSnap?.status).toBe("results");
    expect(finalSnap?.dimmed).toBe(false);
    expect(finalSnap?.items).toHaveLength(1);
  });

  it("second setQuery before grace fires resets the grace timer", () => {
    const scheduler = new FakeScheduler();
    const snapshots: PaletteSearchSnapshot[] = [];
    const controller = new PaletteSearchController(
      source(async () => new Promise(() => {})),
      (snapshot) => snapshots.push(snapshot),
      scheduler,
    );

    controller.setQuery("a");
    scheduler.advanceBy(50);
    controller.setQuery("ab");

    // At this point: first grace was cancelled, second grace starts at t=50
    // 50ms after second setQuery → dimmed=true
    scheduler.advanceBy(100);

    const dimmingSnaps = snapshots.filter((s) => s.dimmed === true);
    expect(dimmingSnaps).toHaveLength(1);
    expect(dimmingSnaps[0]?.query).toBe("ab");
  });

  it("abort path does not affect dimmed on subsequent snapshots after abort", async () => {
    const scheduler = new FakeScheduler();
    const snapshots: PaletteSearchSnapshot[] = [];
    const controller = new PaletteSearchController(
      source(async () => new Promise(() => {})),
      (snapshot) => snapshots.push(snapshot),
      scheduler,
    );

    controller.setQuery("a");
    scheduler.advanceBy(200);
    // in-flight: abort by new query
    controller.setQuery("b");
    scheduler.advanceBy(200);
    await flushMicrotasks();

    // No error snapshot should appear
    const errorSnap = snapshots.find((s) => s.status === "error");
    expect(errorSnap).toBeUndefined();
  });

  it("dispose clears lastSnapshot and cancels all timers", () => {
    const scheduler = new FakeScheduler();
    const snapshots: PaletteSearchSnapshot[] = [];
    const controller = new PaletteSearchController(
      source(async () => [item("X")]),
      (snapshot) => snapshots.push(snapshot),
      scheduler,
    );

    controller.setQuery("x");
    const countBefore = snapshots.length;
    controller.dispose();

    // Advancing after dispose should not emit anything
    scheduler.advanceBy(300);
    expect(snapshots.length).toBe(countBefore);
  });
});

describe("dispose after setQuery during debounce", () => {
  it("no further emissions after dispose, and setQuery after dispose is a no-op", () => {
    const scheduler = new FakeScheduler();
    const snapshots: PaletteSearchSnapshot[] = [];
    const controller = new PaletteSearchController(
      source(async () => [item("Z")]),
      (snapshot) => snapshots.push(snapshot),
      scheduler,
    );

    controller.setQuery("z");
    const countBeforeDispose = snapshots.length;
    controller.dispose();

    // setQuery after dispose must be a no-op
    controller.setQuery("zz");
    scheduler.advanceBy(300);

    expect(snapshots.length).toBe(countBeforeDispose);
  });
});

describe("palette keyboard behavior", () => {
  it("wraps ArrowDown and ArrowUp", () => {
    expect(nextPaletteIndex(2, 3, 1)).toBe(0);
    expect(nextPaletteIndex(0, 3, -1)).toBe(2);
  });

  it("maps Enter, Cmd+Enter, Escape, and Tab", () => {
    expect(resolvePaletteKeyAction({ key: "Enter" }, 0, 1)).toEqual({
      kind: "accept",
      mode: "default",
    });
    expect(resolvePaletteKeyAction({ key: "Enter", metaKey: true }, 0, 1)).toEqual({
      kind: "accept",
      mode: "side",
    });
    expect(resolvePaletteKeyAction({ key: "Escape" }, 0, 1)).toEqual({ kind: "close" });
    expect(resolvePaletteKeyAction({ key: "Tab" }, 0, 1)).toEqual({ kind: "trap-tab" });
  });
});
