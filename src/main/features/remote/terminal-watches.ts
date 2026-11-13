/**
 * The terminals other devices of the account watch on this one
 * (terminal.watch): the renderer, where the terminal lives, tells main what
 * changed of its text, and main numbers each change and sends it to the
 * watching device as a terminal.update. A change too large for a frame is
 * skipped, and an empty one follows it, so the watcher sees a rev missing
 * and watches again.
 */
import { randomUUID } from "node:crypto";
import {
  RpcErrorCode,
  type RpcParams,
  type RpcResult,
  type TerminalUpdate,
} from "../../../../packages/remote-protocol/src";
import type { CliServices } from "../cli/context";
import { fitsInFrame, RpcFailure } from "./room";
import { DEFAULT_TERMINAL_LINES, fitsAsResult, tabOf, unavailable } from "./serve";

/** Most terminals one device may watch here at once; a new one beyond ends its oldest. */
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

  /** Starts a watch for `from`: the terminal's text now. */
  async watch(
    from: string,
    { workspaceId, tabId, lines }: RpcParams<"terminal.watch">,
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
    // Known before the text comes back: a change may come first.
    this.watches.set(watchId, { from, rev: 0 });
    const { text } = await services
      .ui("terminal.watch", {
        workspaceId,
        tabId,
        watchId,
        lines: lines ?? DEFAULT_TERMINAL_LINES,
      })
      .catch((error: unknown) => {
        this.watches.delete(watchId);
        return unavailable(error);
      });
    const result = { text, watchId };
    if (fitsAsResult(result)) return result;
    await this.end(watchId);
    throw new RpcFailure(RpcErrorCode.Unavailable, "the terminal's text is too large to send");
  }

  /** Ends a watch `from` started; another device's is not its to end. */
  async unwatch(
    from: string,
    { watchId }: RpcParams<"terminal.unwatch">,
  ): Promise<RpcResult<"terminal.unwatch">> {
    const watch = this.watches.get(watchId);
    if (!watch || watch.from !== from) throw new RpcFailure(RpcErrorCode.NotFound, "no such watch");
    await this.end(watchId);
    return {};
  }

  /** The renderer tells what changed: numbered and sent to the watcher. */
  async changed(watchId: string, change: Omit<TerminalUpdate, "watchId" | "rev">): Promise<void> {
    const watch = this.watches.get(watchId);
    if (!watch) {
      // A watch main ended, or one from before a restart: the renderer stops it.
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
    // Skipped: the next rev shows the watcher one is missing, and it watches again.
    watch.rev += 1;
    await this.deps.notify(watch.from, { watchId, rev: watch.rev, start: 0, text: "" });
  }

  /** The renderer found the terminal gone. */
  ended(watchId: string): void {
    this.watches.delete(watchId);
  }

  /** A device left the room: its watches end. */
  async dropDevice(deviceId: string): Promise<void> {
    for (const [id, watch] of [...this.watches]) {
      if (watch.from === deviceId) await this.end(id);
    }
  }

  /** This device left the room: every watch ends. */
  async dropAll(): Promise<void> {
    for (const id of [...this.watches.keys()]) await this.end(id);
  }

  /** The devices watching a terminal here now. */
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
