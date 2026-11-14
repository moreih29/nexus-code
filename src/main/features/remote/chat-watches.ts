/**
 * The chats other devices of the account watch on this one (chat.watch):
 * the renderer, where the chat lives, tells main what changed, and main
 * numbers each change and sends it to the watching device as a
 * chat.update. A change too large for a frame is skipped, and an empty one
 * follows it, so the watcher sees a rev missing and watches again.
 */
import { randomUUID } from "node:crypto";
import {
  type ChatUpdate,
  RpcErrorCode,
  type RpcParams,
  type RpcResult,
} from "../../../../packages/remote-protocol/src";
import type { CliServices } from "../cli/context";
import { fitsInFrame, RpcFailure } from "./room";
import { DEFAULT_READ_ITEMS, fitsAsResult, tabOf, unavailable } from "./serve";

/** Most chats one device may watch here at once; a new one beyond ends its oldest. */
export const MAX_WATCHES_PER_DEVICE = 8;

interface Watch {
  from: string;
  rev: number;
  total: number;
}

export interface ChatWatchesDeps {
  services(): CliServices | null;
  notify(to: string, update: ChatUpdate): Promise<boolean>;
}

export class ChatWatches {
  private readonly watches = new Map<string, Watch>();

  constructor(private readonly deps: ChatWatchesDeps) {}

  private servicesOrFail(): CliServices {
    const services = this.deps.services();
    if (!services) throw new RpcFailure(RpcErrorCode.Unavailable, "the app is still starting");
    return services;
  }

  /** Starts a watch for `from`: the chat's page now, of as many items as go in a frame. */
  async watch(
    from: string,
    { workspaceId, tabId, limit }: RpcParams<"chat.watch">,
  ): Promise<RpcResult<"chat.watch">> {
    const services = this.servicesOrFail();
    await tabOf(services, workspaceId, tabId, ["claude", "codex"]);
    const mine = [...this.watches].filter(([, w]) => w.from === from);
    if (mine.length >= MAX_WATCHES_PER_DEVICE) {
      const [oldest] = mine[0] ?? [];
      if (oldest) await this.end(oldest);
    }
    let count = limit ?? DEFAULT_READ_ITEMS;
    for (;;) {
      const watchId = randomUUID();
      // Known before the page comes back: a change may come first.
      this.watches.set(watchId, { from, rev: 0, total: 0 });
      const page = await services
        .ui("chat.watch", { workspaceId, tabId, watchId, limit: count })
        .catch((error: unknown) => {
          this.watches.delete(watchId);
          return unavailable(error);
        });
      const watch = this.watches.get(watchId);
      if (watch) watch.total = page.total;
      const result = { ...page, watchId };
      if (fitsAsResult(result)) return result;
      await this.end(watchId);
      if (page.items.length <= 1) {
        throw new RpcFailure(
          RpcErrorCode.Unavailable,
          "that part of the chat is too large to send",
        );
      }
      count = Math.max(1, Math.floor(page.items.length / 2));
    }
  }

  /** Ends a watch `from` started; another device's is not its to end. */
  async unwatch(
    from: string,
    { watchId }: RpcParams<"chat.unwatch">,
  ): Promise<RpcResult<"chat.unwatch">> {
    const watch = this.watches.get(watchId);
    if (!watch || watch.from !== from) throw new RpcFailure(RpcErrorCode.NotFound, "no such watch");
    await this.end(watchId);
    return {};
  }

  /** The renderer tells what changed: numbered and sent to the watcher. */
  async changed(watchId: string, change: Omit<ChatUpdate, "watchId" | "rev">): Promise<void> {
    const watch = this.watches.get(watchId);
    if (!watch) {
      // A watch main ended, or one from before a restart: the renderer stops it.
      void this.deps
        .services()
        ?.ui("chat.unwatch", { watchId })
        .catch(() => {});
      return;
    }
    watch.rev += 1;
    watch.total = change.total;
    const update: ChatUpdate = { watchId, rev: watch.rev, ...change };
    if (fitsInFrame({ jsonrpc: "2.0", method: "chat.update", params: update })) {
      await this.deps.notify(watch.from, update);
      return;
    }
    // Skipped: the next rev shows the watcher one is missing, and it watches again.
    watch.rev += 1;
    await this.deps.notify(watch.from, {
      watchId,
      rev: watch.rev,
      total: change.total,
      items: [],
      tools: {},
      tasks: {},
      agentItems: {},
    });
  }

  /** The renderer found the chat gone. */
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

  /** The devices watching a chat here now. */
  watchers(): string[] {
    return [...new Set([...this.watches.values()].map((w) => w.from))];
  }

  private async end(watchId: string): Promise<void> {
    this.watches.delete(watchId);
    await this.deps
      .services()
      ?.ui("chat.unwatch", { watchId })
      .catch(() => {});
  }
}
