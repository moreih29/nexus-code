import type { PaletteItem, PaletteSource } from "./types";

export const WORKSPACE_SYMBOL_DEBOUNCE_MS = 200;

export type PaletteViewStatus =
  | "closed"
  | "no-workspace"
  | "idle"
  | "debouncing"
  | "loading"
  | "results"
  | "empty"
  | "error";

export interface PaletteSearchSnapshot<TItem extends PaletteItem = PaletteItem> {
  status: Exclude<PaletteViewStatus, "closed" | "no-workspace">;
  query: string;
  items: readonly TItem[];
  activeIndex: number;
  dimmed?: boolean;
  error?: unknown;
}

export interface PaletteScheduler {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const browserPaletteScheduler: PaletteScheduler = {
  setTimeout: (callback, delayMs) => window.setTimeout(callback, delayMs),
  clearTimeout: (handle) => window.clearTimeout(handle as number),
};

export function initialPaletteSearchSnapshot<
  TItem extends PaletteItem,
>(): PaletteSearchSnapshot<TItem> {
  return { status: "idle", query: "", items: [], activeIndex: -1 };
}

const GRACE_PERIOD_MS = 100;

export class PaletteSearchController<TItem extends PaletteItem> {
  private debounceTimer: unknown | null = null;
  private graceTimer: unknown | null = null;
  private abortController: AbortController | null = null;
  private lastSnapshot: PaletteSearchSnapshot<TItem> | null = null;
  private disposed = false;

  constructor(
    private readonly source: PaletteSource<TItem>,
    private readonly onChange: (snapshot: PaletteSearchSnapshot<TItem>) => void,
    private readonly scheduler: PaletteScheduler = browserPaletteScheduler,
    private readonly debounceMs = WORKSPACE_SYMBOL_DEBOUNCE_MS,
  ) {}

  setQuery(query: string): void {
    if (this.disposed) return;
    this.cancelTimers();
    this.abortInFlight();

    if (query.trim().length < 1) {
      this.emit({ status: "idle", query, items: [], activeIndex: -1 });
      return;
    }

    const previousItems = this.lastSnapshot?.items ?? [];
    const previousActiveIndex = this.lastSnapshot?.activeIndex ?? -1;
    this.emit({
      status: "debouncing",
      query,
      items: previousItems,
      activeIndex: previousActiveIndex,
      dimmed: false,
    });

    this.graceTimer = this.scheduler.setTimeout(() => {
      this.graceTimer = null;
      if (this.disposed) return;
      this.emit({
        status: "debouncing",
        query,
        items: this.lastSnapshot?.items ?? [],
        activeIndex: this.lastSnapshot?.activeIndex ?? -1,
        dimmed: true,
      });
    }, GRACE_PERIOD_MS);

    this.debounceTimer = this.scheduler.setTimeout(() => {
      this.debounceTimer = null;
      void this.run(query);
    }, this.debounceMs);
  }

  dispose(): void {
    this.disposed = true;
    this.cancelTimers();
    this.abortInFlight();
    this.lastSnapshot = null;
  }

  private async run(query: string): Promise<void> {
    if (this.disposed) return;
    const abortController = new AbortController();
    this.abortController = abortController;
    const previousItems = this.lastSnapshot?.items ?? [];
    const previousActiveIndex = this.lastSnapshot?.activeIndex ?? -1;
    this.emit({
      status: "loading",
      query,
      items: previousItems,
      activeIndex: previousActiveIndex,
      dimmed: true,
    });

    try {
      const items = await this.source.search(query, abortController.signal);
      if (this.disposed || abortController.signal.aborted) return;
      this.emit({
        status: items.length > 0 ? "results" : "empty",
        query,
        items,
        activeIndex: items.length > 0 ? 0 : -1,
        dimmed: false,
      });
    } catch (error) {
      if (this.disposed || abortController.signal.aborted) return;
      this.emit({ status: "error", query, items: [], activeIndex: -1, error });
    } finally {
      if (this.abortController === abortController) this.abortController = null;
    }
  }

  private emit(snapshot: PaletteSearchSnapshot<TItem>): void {
    this.lastSnapshot = snapshot;
    this.onChange(snapshot);
  }

  private cancelTimers(): void {
    if (this.debounceTimer !== null) {
      this.scheduler.clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.graceTimer !== null) {
      this.scheduler.clearTimeout(this.graceTimer);
      this.graceTimer = null;
    }
  }

  private abortInFlight(): void {
    this.abortController?.abort();
    this.abortController = null;
  }
}

export function nextPaletteIndex(current: number, count: number, delta: 1 | -1): number {
  if (count <= 0) return -1;
  if (current < 0) return delta > 0 ? 0 : count - 1;
  return (current + delta + count) % count;
}

export type PaletteKeyAction =
  | { kind: "move"; activeIndex: number }
  | { kind: "accept"; mode: "default" | "side" }
  | { kind: "close" }
  | { kind: "trap-tab" }
  | { kind: "none" };

export interface PaletteKeyInput {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
}

export function resolvePaletteKeyAction(
  input: PaletteKeyInput,
  activeIndex: number,
  itemCount: number,
): PaletteKeyAction {
  if (input.key === "ArrowDown") {
    return { kind: "move", activeIndex: nextPaletteIndex(activeIndex, itemCount, 1) };
  }
  if (input.key === "ArrowUp") {
    return { kind: "move", activeIndex: nextPaletteIndex(activeIndex, itemCount, -1) };
  }
  if (input.key === "Enter") {
    return { kind: "accept", mode: input.metaKey || input.ctrlKey ? "side" : "default" };
  }
  if (input.key === "Escape") return { kind: "close" };
  if (input.key === "Tab") return { kind: "trap-tab" };
  return { kind: "none" };
}
