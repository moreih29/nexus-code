/** The terminals other devices watch here: numbered changes, sent to the watcher, ended when it goes. */
import { describe, expect, test } from "bun:test";
import type { TerminalUpdate } from "../../../../../packages/remote-protocol/src";
import type { CliServices } from "../../../../../src/main/features/cli/context";
import { MAX_MESSAGE_BYTES, RpcFailure } from "../../../../../src/main/features/remote/room";
import {
  MAX_TERMINAL_WATCHES_PER_DEVICE,
  TerminalWatches,
} from "../../../../../src/main/features/remote/terminal-watches";

function setup() {
  const asked: [string, Record<string, unknown>][] = [];
  const sent: [string, TerminalUpdate][] = [];
  const services = {
    listWorkspaces: () => [{ id: "w1", name: "app", rootPath: "/src/app" }],
    managerWorkspace: () => null,
    ui: async (op: string, args: Record<string, unknown>) => {
      if (op === "tabs.list") return { tabs: [{ id: "t1", type: "terminal", title: "zsh" }] };
      asked.push([op, args]);
      return op === "terminal.watch" ? { text: "$ ls\nREADME.md" } : {};
    },
  } as unknown as CliServices;
  const watches = new TerminalWatches({
    services: () => services,
    notify: async (to, update) => {
      sent.push([to, update]);
      return true;
    },
  });
  return { watches, asked, sent };
}

const tab = { workspaceId: "w1", tabId: "t1" };

describe("watching a terminal", () => {
  test("starts with its text, then numbers each change for the watcher", async () => {
    const { watches, asked, sent } = setup();
    const { text, watchId } = await watches.watch("phone", { ...tab, lines: 50 });
    expect(text).toBe("$ ls\nREADME.md");
    expect(asked[0]).toEqual(["terminal.watch", { ...tab, watchId, lines: 50 }]);
    await watches.changed(watchId, { start: 14, text: "\n$ " });
    await watches.changed(watchId, { start: 17, text: "git" });
    expect(sent).toEqual([
      ["phone", { watchId, rev: 1, start: 14, text: "\n$ " }],
      ["phone", { watchId, rev: 2, start: 17, text: "git" }],
    ]);
  });

  test("only a terminal tab is watched", async () => {
    const { watches } = setup();
    await expect(watches.watch("phone", { workspaceId: "w1", tabId: "nope" })).rejects.toThrow(
      RpcFailure,
    );
  });

  test("a change too large skips a rev, so the watcher watches again", async () => {
    const { watches, sent } = setup();
    const { watchId } = await watches.watch("phone", tab);
    await watches.changed(watchId, { start: 0, text: "x".repeat(MAX_MESSAGE_BYTES) });
    expect(sent).toEqual([["phone", { watchId, rev: 2, start: 0, text: "" }]]);
  });

  test("ends a watch on unwatch, when its device leaves, and its oldest beyond the most", async () => {
    const { watches, asked } = setup();
    const ids: string[] = [];
    for (let i = 0; i <= MAX_TERMINAL_WATCHES_PER_DEVICE; i++) {
      ids.push((await watches.watch("phone", tab)).watchId);
    }
    expect(asked.filter(([op]) => op === "terminal.unwatch")).toEqual([
      ["terminal.unwatch", { watchId: ids[0] }],
    ]);
    await expect(watches.unwatch("laptop", { watchId: ids[1] as string })).rejects.toThrow(
      RpcFailure,
    );
    await watches.unwatch("phone", { watchId: ids[1] as string });
    await watches.dropDevice("phone");
    expect(watches.watchers()).toEqual([]);
  });
});
