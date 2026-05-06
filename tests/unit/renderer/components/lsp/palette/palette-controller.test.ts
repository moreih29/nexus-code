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
