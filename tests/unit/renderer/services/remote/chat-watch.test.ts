import { describe, expect, test } from "bun:test";
import type {
  ChatPage,
  ChatUpdate,
  ViewItem,
  ViewStreaming,
} from "../../../../../packages/remote-protocol/src";
import type {
  ChatItem,
  ChatModel,
  StreamingMessage,
  ToolCall,
} from "../../../../../src/renderer/services/chat/model";
import { emptyModel } from "../../../../../src/renderer/services/chat/model";
import { emptyTabState } from "../../../../../src/renderer/services/chat/store";
import {
  applyUpdate,
  keepEarlier,
  watchMissedUpdate,
  withEarlier,
} from "../../../../../src/renderer/services/remote/chat-model";
import { chatPageOf } from "../../../../../src/renderer/services/remote/chat-page";
import {
  appendsOf,
  changesOf,
  eachTimeItCan,
  sentOf,
  streamAppendsOf,
  windowStart,
} from "../../../../../src/renderer/services/remote/chat-watch";

const user = (key: string): ChatItem => ({
  kind: "user",
  key,
  text: key,
  images: [],
  state: "taken",
});
const saying = (key: string, text: string, ...tools: string[]): ChatItem => ({
  kind: "assistant",
  key,
  messageId: `m-${key}`,
  blocks: [
    { type: "text", text },
    ...tools.map((id) => ({ type: "tool" as const, toolUseId: id })),
  ],
});
const said = (key: string, ...tools: string[]): ChatItem => saying(key, key, ...tools);
const tool = (id: string, status: ToolCall["status"] = "running"): ToolCall => ({
  id,
  name: "Bash",
  input: { command: "ls" },
  status,
  parentToolUseId: null,
});
const source = (model: Partial<ChatModel>) => ({
  agent: "claude" as const,
  title: "T",
  chat: { ...emptyTabState(), model: { ...emptyModel(), ...model } },
});
const put = (page: ChatPage, update: ChatUpdate): ChatPage => {
  const next = applyUpdate(page, update);
  if (!next) throw new Error("the update found nothing to append to");
  return next;
};

describe("a watched chat's changes", () => {
  const items = [user("a"), said("b", "t1")];
  const tools = { t1: tool("t1") };
  const before = source({ items, tools, running: true });

  test("nothing changed is nothing to send", () => {
    expect(
      changesOf(sentOf(before, 0), sentOf(source({ items, tools, running: true }), 0)),
    ).toBeNull();
  });

  test("sends only the items and calls that are new objects, and the status when it changed", () => {
    const done = tool("t1", "done");
    const after = source({ items: [...items, said("c")], tools: { t1: done }, running: false });
    const change = changesOf(sentOf(before, 0), sentOf(after, 0));
    expect(change?.items.map((i) => [i.index, i.item.key])).toEqual([[2, "c"]]);
    expect(Object.keys(change?.tools ?? {})).toEqual(["t1"]);
    expect(change?.status?.running).toBe(false);
    expect(change?.total).toBe(3);
  });

  test("a conversation that got shorter is cut, and the window moves back when it must", () => {
    const after = source({ items: [user("z")], tools: {} });
    const change = changesOf(sentOf(before, 0), sentOf(after, 0));
    expect(change?.total).toBe(1);
    expect(change?.items.map((i) => i.item.key)).toEqual(["z"]);
    expect(windowStart(150, 40, 100)).toBe(0);
    expect(windowStart(150, 400, 100)).toBe(150);
    expect(windowStart(150, 120, 100)).toBe(20);
  });

  for (const appends of [false, true]) {
    test(`the watcher's page with each update is the page read anew (appends ${appends ? "on" : "off"})`, () => {
      let page: ChatPage = chatPageOf(before);
      let sent = sentOf(before, page.start);
      let rev = 0;
      const streaming = (blocks: StreamingMessage["blocks"]) => ({ messageId: "m", blocks });
      const steps = [
        source({
          items,
          tools,
          running: true,
          streaming: streaming({ 0: { type: "text", text: "He" } }),
        }),
        source({
          items,
          tools,
          running: true,
          streaming: streaming({ 0: { type: "text", text: "Hello" } }),
        }),
        source({
          items,
          tools,
          running: true,
          streaming: streaming({
            0: { type: "text", text: "Hello" },
            1: { type: "tool_use", text: "", toolUseId: "t2" },
          }),
        }),
        source({
          items,
          tools,
          running: true,
          turn: { outputTokens: 12 },
          streaming: streaming({
            0: { type: "text", text: "Hello" },
            1: { type: "tool_use", text: '{"command":', toolUseId: "t2" },
          }),
        }),
        source({ items: [...items, saying("c", "Hel")], tools, running: true }),
        source({ items: [...items, saying("c", "Hello there")], tools, running: true }),
        source({
          items: [...items, saying("c", "Hello there", "t2")],
          tools: { ...tools, t2: tool("t2") },
          running: true,
        }),
        source({
          items: [...items, saying("c", "Hello there", "t2")],
          tools: { t1: tool("t1", "done"), t2: tool("t2", "done") },
        }),
      ];
      for (const step of steps) {
        const now = sentOf(step, sent.window.start);
        const change = changesOf(sent, now, appends);
        sent = now;
        if (change) page = put(page, { watchId: "w", rev: ++rev, ...change });
        expect(page).toEqual(chatPageOf(step));
      }
    });
  }
});

describe("recovering a quiet watch from a page read", () => {
  const items = [user("a"), said("b", "t1"), said("c")];
  const tools = { t1: tool("t1") };
  const request = { requestId: "p", toolName: "Bash", input: {}, suggestions: [] };
  const read = (change: Partial<ChatModel>) =>
    chatPageOf(source({ items, tools, running: true, permissions: [request], ...change }));

  test("detects a lost turn end or approval cancellation without new messages", () => {
    const current = read({});
    const finished = read({ running: false });
    const cancelled = read({ permissions: [] });
    expect(finished.total).toBe(current.total);
    expect(cancelled.total).toBe(current.total);
    expect(watchMissedUpdate(current, finished)).toBe(true);
    expect(watchMissedUpdate(current, cancelled)).toBe(true);
  });

  test("detects a lost tool completion on an older item with unchanged status and count", () => {
    const current = read({});
    const completed = read({ tools: { t1: tool("t1", "done") } });
    expect(completed.status).toEqual(current.status);
    expect(completed.total).toBe(current.total);
    expect(watchMissedUpdate(current, completed)).toBe(true);
  });

  test("a narrower read and frame-truncated tool output do not restart an unchanged watch", () => {
    const completed = {
      ...tool("t1", "done"),
      result: { text: "the complete output", isError: false, images: [] },
    };
    const current = read({ tools: { t1: completed } });
    const narrowed: ChatPage = {
      ...current,
      start: 1,
      items: current.items.slice(1),
      tools: {
        t1: { ...completed, result: { ...completed.result, text: "the", truncated: true } },
      },
    };
    expect(watchMissedUpdate(current, narrowed)).toBe(false);
  });
});

describe("text that only grew, sent as what it grew by", () => {
  const items = [user("a"), saying("b", "Hel")];
  const before = source({
    items,
    running: true,
    streaming: { messageId: "m", blocks: { 0: { type: "text", text: "He" } } },
  });

  test("an assistant item's text that grew comes as appends, for a watch that takes them", () => {
    const after = source({ ...before.chat.model, items: [items[0], saying("b", "Hello")] });
    const change = changesOf(sentOf(before, 0), sentOf(after, 0), true);
    expect(change?.items).toEqual([]);
    expect(change?.appends).toEqual([{ index: 1, block: 0, text: "lo" }]);
    const whole = changesOf(sentOf(before, 0), sentOf(after, 0));
    expect(whole?.items.map((i) => i.index)).toEqual([1]);
    expect(whole?.appends).toBeUndefined();
  });

  test("the reply being written that grew comes as streamAppends, its status only when the rest changed", () => {
    const grown = source({
      ...before.chat.model,
      streaming: { messageId: "m", blocks: { 0: { type: "text", text: "Hello" } } },
    });
    const change = changesOf(sentOf(before, 0), sentOf(grown, 0), true);
    expect(change?.status).toBeUndefined();
    expect(change?.streamAppends).toEqual([{ block: 0, text: "llo" }]);

    const counted = source({ ...grown.chat.model, turn: { outputTokens: 3 } });
    const both = changesOf(sentOf(before, 0), sentOf(counted, 0), true);
    expect(both?.status?.turn?.outputTokens).toBe(3);
    expect(both?.status && "streaming" in both.status).toBe(false);
    expect(both?.streamAppends).toEqual([{ block: 0, text: "llo" }]);

    const whole = changesOf(sentOf(before, 0), sentOf(grown, 0));
    expect(whole?.status?.streaming?.blocks[0]?.text).toBe("Hello");
    expect(whole?.streamAppends).toBeUndefined();
  });

  test("an item that changed other than by growing goes whole", () => {
    const view = (blocks: unknown[], extra: object = {}): ViewItem =>
      ({ kind: "assistant", key: "b", messageId: "m-b", blocks, ...extra }) as ViewItem;
    const was = view([
      { type: "text", text: "Hel" },
      { type: "tool", toolUseId: "t1" },
    ]);
    expect(
      appendsOf(
        was,
        view([
          { type: "text", text: "Hello" },
          { type: "tool", toolUseId: "t1" },
        ]),
        4,
      ),
    ).toEqual([{ index: 4, block: 0, text: "lo" }]);
    expect(appendsOf(was, was, 4)).toBeNull();
    expect(
      appendsOf(
        was,
        view([
          { type: "text", text: "Hi" },
          { type: "tool", toolUseId: "t1" },
        ]),
        4,
      ),
    ).toBeNull();
    expect(appendsOf(was, view([{ type: "text", text: "Hello" }]), 4)).toBeNull();
    expect(
      appendsOf(
        was,
        view([
          { type: "text", text: "Hello" },
          { type: "tool", toolUseId: "t9" },
        ]),
        4,
      ),
    ).toBeNull();
    expect(
      appendsOf(
        was,
        view([
          { type: "thinking", text: "Hello" },
          { type: "tool", toolUseId: "t1" },
        ]),
        4,
      ),
    ).toBeNull();
    expect(
      appendsOf(
        was,
        view(
          [
            { type: "text", text: "Hello" },
            { type: "tool", toolUseId: "t1" },
          ],
          { messageId: "other" },
        ),
        4,
      ),
    ).toBeNull();
    expect(appendsOf({ kind: "notice", key: "b", code: "x" }, was, 4)).toBeNull();
  });

  test("the reply being written: another one, or a block more, goes whole", () => {
    const reply = (text: string, more: ViewStreaming["blocks"] = []): ViewStreaming => ({
      messageId: "m",
      blocks: [{ type: "text", text }, ...more],
    });
    expect(streamAppendsOf(reply("He"), reply("He"))).toEqual([]);
    expect(streamAppendsOf(reply("He"), reply("Hey"))).toEqual([{ block: 0, text: "y" }]);
    expect(
      streamAppendsOf(
        reply("He", [{ type: "tool_use", text: "{", toolUseId: "t" }]),
        reply("He", [{ type: "tool_use", text: '{"a"', toolUseId: "t" }]),
      ),
    ).toEqual([{ block: 1, text: '"a"' }]);
    expect(streamAppendsOf(reply("He"), { ...reply("Hey"), messageId: "n" })).toBeNull();
    expect(streamAppendsOf(reply("He"), reply("He", [{ type: "text", text: "" }]))).toBeNull();
    expect(streamAppendsOf(reply("He"), reply("Ha"))).toBeNull();
    expect(streamAppendsOf(null, reply("He"))).toBeNull();
    expect(streamAppendsOf(reply("He"), null)).toBeNull();
  });
});

describe("putting an update in a page", () => {
  const page: ChatPage = {
    ...chatPageOf(source({})),
    start: 10,
    total: 12,
    items: [
      { kind: "notice", key: "n10", code: "x" },
      { kind: "notice", key: "n11", code: "x" },
    ],
  };
  const update = { watchId: "w", rev: 1, tools: {}, tasks: {}, agentItems: {} };

  test("puts items at their index and grows the list", () => {
    const next = put(page, {
      ...update,
      total: 13,
      items: [
        { index: 11, item: { kind: "notice", key: "n11b", code: "x" } },
        { index: 12, item: { kind: "notice", key: "n12", code: "x" } },
      ],
    });
    expect([next.start, next.total]).toEqual([10, 13]);
    expect(next.items.map((i) => i.key)).toEqual(["n10", "n11b", "n12"]);
  });

  test("cuts the list at a shorter total, and moves its start back for an earlier item", () => {
    const next = put(page, {
      ...update,
      total: 2,
      items: [
        { index: 0, item: { kind: "notice", key: "a", code: "x" } },
        { index: 1, item: { kind: "notice", key: "b", code: "x" } },
      ],
    });
    expect([next.start, next.total]).toEqual([0, 2]);
    expect(next.items.map((i) => i.key)).toEqual(["a", "b"]);
  });

  const said: ChatPage = {
    ...page,
    items: [
      { kind: "notice", key: "n10", code: "x" },
      {
        kind: "assistant",
        key: "a11",
        messageId: "m",
        blocks: [
          { type: "text", text: "Hel" },
          { type: "tool", toolUseId: "t" },
        ],
      },
    ],
    status: {
      ...page.status,
      streaming: { messageId: "s", blocks: [{ type: "text", text: "He" }] },
    },
  };
  const grow = (rest: Partial<ChatUpdate>): ChatPage | null =>
    applyUpdate(said, { ...update, total: 12, items: [], ...rest });

  test("appends text to an item's block, and to the reply being written", () => {
    const next = grow({
      appends: [{ index: 11, block: 0, text: "lo" }],
      streamAppends: [{ block: 0, text: "y" }],
    });
    expect(next?.items[1]).toEqual({
      ...said.items[1],
      blocks: [
        { type: "text", text: "Hello" },
        { type: "tool", toolUseId: "t" },
      ],
    } as ViewItem);
    expect(next?.status.streaming?.blocks[0]?.text).toBe("Hey");
    expect(said.status.streaming?.blocks[0]?.text).toBe("He");
  });

  test("a status sent without the reply keeps the watcher's; one sent with null ends it", () => {
    const { streaming: _, ...rest } = said.status;
    expect(grow({ status: { ...rest, running: true } })?.status).toEqual({
      ...said.status,
      running: true,
    });
    expect(grow({ status: { ...rest, streaming: null } })?.status.streaming).toBeNull();
    expect(
      grow({ status: rest, streamAppends: [{ block: 0, text: "llo" }] })?.status.streaming,
    ).toEqual({ messageId: "s", blocks: [{ type: "text", text: "Hello" }] });
  });

  test("an append before the page is not the watcher's to show", () => {
    expect(grow({ appends: [{ index: 3, block: 0, text: "x" }] })?.items).toEqual(said.items);
  });

  test("an append with nothing to go on is null, so the watch starts again", () => {
    expect(grow({ appends: [{ index: 10, block: 0, text: "x" }] })).toBeNull();
    expect(grow({ appends: [{ index: 11, block: 1, text: "x" }] })).toBeNull();
    expect(grow({ appends: [{ index: 11, block: 5, text: "x" }] })).toBeNull();
    expect(grow({ streamAppends: [{ block: 3, text: "x" }] })).toBeNull();
    const { streaming: _, ...rest } = said.status;
    expect(
      grow({ status: { ...rest, streaming: null }, streamAppends: [{ block: 0, text: "x" }] }),
    ).toBeNull();
  });
});

describe("a watched chat's earlier items", () => {
  const notes = (from: number, to: number): ViewItem[] =>
    Array.from({ length: to - from }, (_, i) => ({
      kind: "notice",
      key: `n${from + i}`,
      code: "x",
    }));
  const base = chatPageOf(source({}));
  const pageOf = (start: number, total: number, items = notes(start, total)): ChatPage => ({
    ...base,
    start,
    total,
    items,
  });
  const keys = (page: ChatPage) => page.items.map((item) => item.key);

  test("a page read before the shown ones goes in front, with its calls", () => {
    const shown = pageOf(10, 14);
    const earlier = {
      ...pageOf(6, 14, notes(6, 10)),
      tools: { t: { id: "t", name: "Read", input: {}, status: "done" } },
    } as ChatPage;
    const next = withEarlier(shown, earlier);
    expect([next.start, next.total]).toEqual([6, 14]);
    expect(keys(next)).toEqual(["n6", "n7", "n8", "n9", "n10", "n11", "n12", "n13"]);
    expect(Object.keys(next.tools)).toEqual(["t"]);
  });

  test("one that does not end where the shown ones start is left out", () => {
    const shown = pageOf(10, 14);
    expect(withEarlier(shown, pageOf(4, 14, notes(4, 8)))).toBe(shown);
  });

  test("watched again, the items shown before its last ones stay in front", () => {
    const old = pageOf(0, 12);
    const fresh = { ...pageOf(10, 14), panel: { jobs: [] } };
    const next = keepEarlier(old, fresh);
    expect([next.start, next.total]).toEqual([0, 14]);
    expect(keys(next)).toEqual(keys(pageOf(0, 14)));
    expect(next.panel).toBe(fresh.panel);
  });

  test("and those of an old page that ends where the new one starts", () => {
    expect(keys(keepEarlier(pageOf(0, 10), pageOf(10, 13)))).toEqual(keys(pageOf(0, 13)));
  });

  test("watched again, a page that does not meet or agree with the old one stands alone", () => {
    const fresh = pageOf(10, 14);
    expect(keepEarlier(pageOf(0, 8), fresh)).toBe(fresh);
    const changed = pageOf(10, 14, [{ kind: "notice", key: "other", code: "x" }, ...notes(11, 14)]);
    expect(keepEarlier(pageOf(0, 12), changed)).toBe(changed);
    expect(keepEarlier(pageOf(10, 12), fresh)).toBe(fresh);
    const empty = pageOf(5, 5, []);
    expect(keepEarlier(pageOf(0, 8), empty)).toBe(empty);
  });
});

describe("asking again as the watched tab's program comes to take questions", () => {
  test("acts once each time it can, not on every change while it can", () => {
    let can = false;
    let acted = 0;
    const check = eachTimeItCan(
      () => can,
      () => acted++,
    );
    check();
    expect(acted).toBe(0);
    can = true;
    check();
    check();
    expect(acted).toBe(1);
    can = false;
    check();
    can = true;
    check();
    expect(acted).toBe(2);
  });
});
