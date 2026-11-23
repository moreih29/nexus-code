import { randomUUID } from "node:crypto";
import {
  RpcErrorCode,
  type RpcParams,
  type RpcResult,
  type TerminalUpdate,
} from "../../../../packages/remote-protocol/src";
import type { CliServices } from "../cli/context";
import { fitsInFrame, RpcFailure } from "./room";
import { fitsAsResult, tabOf, unavailable } from "./serving/common";
import { DEFAULT_TERMINAL_LINES } from "./serving/terminal";

export const MAX_TERMINAL_WATCHES_PER_DEVICE = 4;

interface Watch {
  from: string;
  rev: number;
}

export interface TerminalWatchesDeps {
  services(): CliServices | null;
  notify(to: string, update: TerminalUpdate): Promise<boolean>;
}

export class TerminalWatches {
  private readonly watches = new Map<string, Watch>();

  constructor(private readonly deps: TerminalWatchesDeps) {}

  async watch(
    from: string,
    { workspaceId, tabId, lines, ansi }: RpcParams<"terminal.watch">,
  ): Promise<RpcResult<"terminal.watch">> {
    const services = this.deps.services();
    if (!services) throw new RpcFailure(RpcErrorCode.Unavailable, "the app is still starting");
    await tabOf(services, workspaceId, tabId, ["terminal"]);
    const mine = [...this.watches].filter(([, w]) => w.from === from);
    if (mine.length >= MAX_TERMINAL_WATCHES_PER_DEVICE) {
      const [oldest] = mine[0] ?? [];
      if (oldest) await this.end(oldest);
    }
    const watchId = randomUUID();
    this.watches.set(watchId, { from, rev: 0 });
    const { text, caret } = await services
      .ui("terminal.watch", {
        workspaceId,
        tabId,
        watchId,
        lines: lines ?? DEFAULT_TERMINAL_LINES,
        ...(ansi ? { ansi } : {}),
      })
      .catch((error: unknown) => {
        this.watches.delete(watchId);
        return unavailable(error);
      });
    const result = { text, watchId, ...(caret ? { caret } : {}) };
    if (fitsAsResult(result)) return result;
    await this.end(watchId);
    throw new RpcFailure(RpcErrorCode.Unavailable, "the terminal's text is too large to send");
  }

  async unwatch(
    from: string,
    { watchId }: RpcParams<"terminal.unwatch">,
  ): Promise<RpcResult<"terminal.unwatch">> {
    const watch = this.watches.get(watchId);
    if (!watch || watch.from !== from) throw new RpcFailure(RpcErrorCode.NotFound, "no such watch");
    await this.end(watchId);
    return {};
  }

  async changed(watchId: string, change: Omit<TerminalUpdate, "watchId" | "rev">): Promise<void> {
    const watch = this.watches.get(watchId);
    if (!watch) {
      void this.deps
        .services()
        ?.ui("terminal.unwatch", { watchId })
        .catch(() => {});
      return;
    }
    watch.rev += 1;
    const update: TerminalUpdate = { watchId, rev: watch.rev, ...change };
    if (fitsInFrame({ jsonrpc: "2.0", method: "terminal.update", params: update })) {
      await this.deps.notify(watch.from, update);
      return;
    }
    watch.rev += 1;
    await this.deps.notify(watch.from, { watchId, rev: watch.rev, start: 0, text: "" });
  }

  ended(watchId: string): void {
    this.watches.delete(watchId);
  }

  async dropDevice(deviceId: string): Promise<void> {
    for (const [id, watch] of [...this.watches]) {
      if (watch.from === deviceId) await this.end(id);
    }
  }

  async dropAll(): Promise<void> {
    for (const id of [...this.watches.keys()]) await this.end(id);
  }

  watchers(): string[] {
    return [...new Set([...this.watches.values()].map((w) => w.from))];
  }

  private async end(watchId: string): Promise<void> {
    this.watches.delete(watchId);
    await this.deps
      .services()
      ?.ui("terminal.unwatch", { watchId })
      .catch(() => {});
  }
}
