import { randomUUID } from "node:crypto";
import {
  type ChatUpdate,
  RpcErrorCode,
  type RpcParams,
  type RpcResult,
} from "../../../../packages/remote-protocol/src";
import type { CliServices } from "../cli/context";
import { fitsInFrame, RpcFailure } from "./room";
import { DEFAULT_READ_ITEMS, fitOversizeCodexChildren, fitPage } from "./serving/chat-details";
import { fitsAsResult, tabOf, unavailable } from "./serving/common";

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

  async watch(
    from: string,
    { workspaceId, tabId, limit, appends }: RpcParams<"chat.watch">,
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
      this.watches.set(watchId, { from, rev: 0, total: 0 });
      const page = await services
        .ui("chat.watch", {
          workspaceId,
          tabId,
          watchId,
          limit: count,
          ...(appends ? { appends: true } : {}),
        })
        .catch((error: unknown) => {
          this.watches.delete(watchId);
          return unavailable(error);
        });
      const watch = this.watches.get(watchId);
      if (watch) watch.total = page.total;
      const result = { ...page, watchId };
      if (fitsAsResult(result)) return result;
      const fittedChildren = fitOversizeCodexChildren(result);
      if (fittedChildren) return fittedChildren;
      const fitted = page.items.length <= 1 ? fitPage(result) : null;
      if (fitted) return fitted;
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

  async unwatch(
    from: string,
    { watchId }: RpcParams<"chat.unwatch">,
  ): Promise<RpcResult<"chat.unwatch">> {
    const watch = this.watches.get(watchId);
    if (!watch || watch.from !== from) throw new RpcFailure(RpcErrorCode.NotFound, "no such watch");
    await this.end(watchId);
    return {};
  }

  async changed(watchId: string, change: Omit<ChatUpdate, "watchId" | "rev">): Promise<void> {
    const watch = this.watches.get(watchId);
    if (!watch) {
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
      ?.ui("chat.unwatch", { watchId })
      .catch(() => {});
  }
}
