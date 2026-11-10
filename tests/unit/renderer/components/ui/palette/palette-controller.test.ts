import { describe, expect, it, mock } from "bun:test";
import {
  type PaletteScheduler,
  PaletteSearchController,
  type PaletteSearchSnapshot,
  WORKSPACE_SYMBOL_DEBOUNCE_MS,
} from "../../../../../../src/renderer/components/ui/palette/controller";
import type {
  PaletteItem,
  PaletteSource,
} from "../../../../../../src/renderer/components/ui/palette/types";

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

function source(
  search: PaletteSource["search"],
  options: { searchOnEmptyQuery?: boolean } = {},
): PaletteSource {
  return {
    id: "test",
    title: "Test",
    placeholder: "Search",
    emptyQueryMessage: "Type",
    noResultsMessage: "None",
    ...(options.searchOnEmptyQuery !== undefined
      ? { searchOnEmptyQuery: options.searchOnEmptyQuery }
      : {}),
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

  it("calls the source immediately for empty queries when searchOnEmptyQuery is true", async () => {
    const scheduler = new FakeScheduler();
    const search = mock(async () => [item("main"), item("dev")]);
    const snapshots: PaletteSearchSnapshot[] = [];
    const controller = new PaletteSearchController(
      source(search, { searchOnEmptyQuery: true }),
      (snapshot) => snapshots.push(snapshot),
      scheduler,
    );

    // No debounce wait — the empty-query path should fire search() at once.
    controller.setQuery("");
    expect(search).toHaveBeenCalledTimes(1);
    await flushMicrotasks();

    const final = snapshots.at(-1);
    expect(final?.status).toBe("results");
    expect(final?.items).toHaveLength(2);
  });

  it("searchOnEmptyQuery still applies debounce for non-empty queries", async () => {
    const scheduler = new FakeScheduler();
    const search = mock(async () => [item("main")]);
    const controller = new PaletteSearchController(
      source(search, { searchOnEmptyQuery: true }),
      () => {},
      scheduler,
    );

    controller.setQuery("ma");
    expect(search).not.toHaveBeenCalled();
    scheduler.advanceBy(WORKSPACE_SYMBOL_DEBOUNCE_MS);
    expect(search).toHaveBeenCalledTimes(1);
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

describe("flush()", () => {
  it("cancels the debounce timer and runs search immediately, returning the fresh snapshot", async () => {
    const scheduler = new FakeScheduler();
    const createItem = item("create:feat/new-x");
    const search = mock(async (_query: string) => [createItem]);
    const snapshots: PaletteSearchSnapshot[] = [];
    const controller = new PaletteSearchController(
      source(search),
      (snapshot) => snapshots.push(snapshot),
      scheduler,
    );

    // Simulate fast typing — debounce has NOT fired yet
    controller.setQuery("feat/new-x");
    expect(search).not.toHaveBeenCalled();

    // flush() must cancel the timer and run search immediately
    const result = await controller.flush();

    expect(search).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("results");
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.id).toBe("create:feat/new-x");
    // The debounce timer should NOT fire a second search afterward
    scheduler.advanceBy(WORKSPACE_SYMBOL_DEBOUNCE_MS);
    expect(search).toHaveBeenCalledTimes(1);
  });

  it("awaits an already in-flight search (status=loading) and returns its result", async () => {
    const scheduler = new FakeScheduler();
    let resolveSearch: (items: PaletteItem[]) => void = () => {};
    const search = mock(
      (_query: string, _signal: AbortSignal) =>
        new Promise<PaletteItem[]>((resolve) => {
          resolveSearch = resolve;
        }),
    );
    const snapshots: PaletteSearchSnapshot[] = [];
    const controller = new PaletteSearchController(
      source(search),
      (snapshot) => snapshots.push(snapshot),
      scheduler,
    );

    // Let the debounce fire so we enter "loading" status
    controller.setQuery("main");
    scheduler.advanceBy(WORKSPACE_SYMBOL_DEBOUNCE_MS);
    expect(snapshots.at(-1)?.status).toBe("loading");

    // flush() while loading: must await the running search
    const flushPromise = controller.flush();
    resolveSearch([item("main")]);
    const result = await flushPromise;

    expect(result.status).toBe("results");
    expect(result.items[0]?.id).toBe("main");
  });

  it("returns the current lastSnapshot if neither debounce nor in-flight is active", async () => {
    const scheduler = new FakeScheduler();
    const search = mock(async () => [item("Alpha")]);
    const snapshots: PaletteSearchSnapshot[] = [];
    const controller = new PaletteSearchController(
      source(search),
      (snapshot) => snapshots.push(snapshot),
      scheduler,
    );

    controller.setQuery("al");
    scheduler.advanceBy(WORKSPACE_SYMBOL_DEBOUNCE_MS);
    await flushMicrotasks();

    // Search has completed; no pending timers
    const result = await controller.flush();
    expect(result.status).toBe("results");
    expect(result.items[0]?.id).toBe("Alpha");
    // search should not have been called again
    expect(search).toHaveBeenCalledTimes(1);
  });

  it("returns an idle fallback snapshot when called on a disposed controller", async () => {
    const scheduler = new FakeScheduler();
    const controller = new PaletteSearchController(
      source(async () => [item("Z")]),
      () => {},
      scheduler,
    );

    controller.dispose();
    const result = await controller.flush();
    expect(result.status).toBe("idle");
    expect(result.items).toHaveLength(0);
  });
});
