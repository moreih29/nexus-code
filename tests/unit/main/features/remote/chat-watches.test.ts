/** The chats other devices watch here: numbered changes, sent to the watcher, ended when it goes. */
import { describe, expect, test } from "bun:test";
import type { ChatUpdate } from "../../../../../packages/remote-protocol/src";
import type { CliServices } from "../../../../../src/main/features/cli/context";
import {
  ChatWatches,
  MAX_WATCHES_PER_DEVICE,
} from "../../../../../src/main/features/remote/chat-watches";
import { MAX_MESSAGE_BYTES } from "../../../../../src/main/features/remote/room";

function setup(pageItems = 0) {
  const asked: [string, Record<string, unknown>][] = [];
  const sent: [string, ChatUpdate][] = [];
  const services = {
    listWorkspaces: () => [{ id: "w1", name: "app", rootPath: "/src/app" }],
    managerWorkspace: () => null,
    ui: async (op: string, args: Record<string, unknown>) => {
      if (op === "tabs.list") return { tabs: [{ id: "t1", type: "claude", title: "Chat" }] };
      asked.push([op, args]);
      if (op === "chat.watch") {
        const n = Math.min(Number(args.limit), pageItems || 1);
        return {
          start: 0,
          total: n,
          items: Array.from({ length: pageItems ? n : 0 }, (_, i) => ({
            kind: "shell",
            key: `k${i}`,
            command: "x".repeat(200_000),
          })),
          tools: {},
          tasks: {},
          agentItems: {},
        };
      }
      return {};
    },
  } as unknown as CliServices;
  const watches = new ChatWatches({
    services: () => services,
    notify: async (to, update) => {
      sent.push([to, update]);
      return true;
    },
  });
  return { watches, asked, sent };
}

const chat = { workspaceId: "w1", tabId: "t1" };
const change = { total: 1, items: [], tools: {}, tasks: {}, agentItems: {} };

describe("the chats watched here", () => {
  test("a watch's changes go to its device, numbered from 1", async () => {
    const { watches, sent } = setup();
    const { watchId } = await watches.watch("d1", chat);
    await watches.changed(watchId, change);
    await watches.changed(watchId, { ...change, total: 2 });
    expect(sent.map(([to, u]) => [to, u.watchId, u.rev, u.total])).toEqual([
      ["d1", watchId, 1, 1],
      ["d1", watchId, 2, 2],
    ]);
  });

  test("a change too large for a frame is skipped, so the watcher sees a rev missing", async () => {
    const { watches, sent } = setup();
    const { watchId } = await watches.watch("d1", chat);
    await watches.changed(watchId, {
      ...change,
      items: [
        { index: 0, item: { kind: "shell", key: "k", command: "x".repeat(MAX_MESSAGE_BYTES) } },
      ],
    });
    expect(sent.map(([, u]) => [u.rev, u.items.length])).toEqual([[2, 0]]);
  });

  test("a first page too large is watched again with fewer items", async () => {
    const { watches, asked } = setup(20);
    const page = await watches.watch("d1", { ...chat, limit: 20 });
    expect(asked.filter(([op]) => op === "chat.watch").map(([, a]) => a.limit)).toEqual([
      20, 10, 5, 2,
    ]);
    expect(asked.filter(([op]) => op === "chat.unwatch")).toHaveLength(3);
    expect(page.items).toHaveLength(2);
  });

  test("only its device ends a watch; a device leaving ends all of its own", async () => {
    const { watches, asked } = setup();
    const a = await watches.watch("d1", chat);
    const b = await watches.watch("d1", chat);
    const c = await watches.watch("d2", chat);
    await expect(watches.unwatch("d2", { watchId: a.watchId })).rejects.toMatchObject({
      code: 1001,
    });
    await watches.unwatch("d1", { watchId: a.watchId });
    await watches.dropDevice("d1");
    expect(asked.filter(([op]) => op === "chat.unwatch").map(([, x]) => x.watchId)).toEqual([
      a.watchId,
      b.watchId,
    ]);
    expect(watches.watchers()).toEqual(["d2"]);
    await watches.dropAll();
    expect(asked.at(-1)).toEqual(["chat.unwatch", { watchId: c.watchId }]);
  });

  test("a device watching too many ends its oldest", async () => {
    const { watches, asked } = setup();
    const first = await watches.watch("d1", chat);
    for (let i = 1; i < MAX_WATCHES_PER_DEVICE; i++) await watches.watch("d1", chat);
    await watches.watch("d1", chat);
    expect(asked.filter(([op]) => op === "chat.unwatch").map(([, x]) => x.watchId)).toEqual([
      first.watchId,
    ]);
  });

  test("a change for a watch it does not have stops it in the renderer", async () => {
    const { watches, asked, sent } = setup();
    await watches.changed("old", change);
    expect(sent).toEqual([]);
    expect(asked).toEqual([["chat.unwatch", { watchId: "old" }]]);
  });
});
