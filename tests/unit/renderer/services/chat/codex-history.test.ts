import { describe, expect, test } from "bun:test";
import { ChatPageSchema } from "../../../../../packages/remote-protocol/src";
import {
  codexForkPrefix,
  codexHistoryAvailable,
  codexHistoryBusy,
  validCodexFork,
} from "../../../../../src/renderer/services/chat/codex-history";
import {
  applyCodexLine,
  emptyCodexModel,
} from "../../../../../src/renderer/services/chat/codex-model";
import type { ChatLine } from "../../../../../src/renderer/services/chat/model";
import { emptyTabState } from "../../../../../src/renderer/services/chat/store";
import { chatPageOf } from "../../../../../src/renderer/services/remote/chat-page";
import {
  appendsOf,
  changesOf,
  sentOf,
} from "../../../../../src/renderer/services/remote/chat-watch";

const user = (id: string) => ({
  type: "userMessage",
  id,
  content: [{ type: "text", text: id }],
});
const answer = (id: string) => ({ type: "agentMessage", id, text: id });
const first = { id: "first", status: "completed", items: [user("prompt"), answer("answer")] };
const second = {
  id: "second",
  status: "completed",
  items: [user("second prompt"), answer("interim"), user("steer"), answer("final")],
};

function harness(version = "0.170.0") {
  let seq = 0;
  let model = { ...emptyCodexModel(), appServerVersion: version };
  const line = (dir: ChatLine["dir"], message: Record<string, unknown>) => {
    model = applyCodexLine(model, { seq: ++seq, dir, message } as ChatLine) as typeof model;
  };
  const send = (id: string, method: string, params = {}) => line("in", { id, method, params });
  const reply = (id: string, result: unknown) => line("out", { id, result });
  const source = () => ({
    agent: "codex" as const,
    title: "Test",
    chat: { ...emptyTabState(), model },
  });
  send("resume", "thread/resume");
  reply("resume", { thread: { id: "parent", turns: [first, second] } });
  return {
    line,
    send,
    reply,
    source,
    get model() {
      return model;
    },
  };
}

describe("Codex message history boundaries", () => {
  test("supports first inputs and final assistant groups, and excludes steer and intermediate answers", () => {
    const h = harness();
    expect(h.model.items.map((item) => [item.kind, "forkable" in item && item.forkable])).toEqual([
      ["user", true],
      ["assistant", true],
      ["user", true],
      ["assistant", false],
      ["user", false],
      ["assistant", true],
    ]);
    const page = ChatPageSchema.parse(chatPageOf(h.source()));
    expect(page.items[2]).toMatchObject({ forkable: true, rewindable: true });
    expect(page.items[4]).not.toHaveProperty("rewindable");
    expect(harness("0.166.0").model.items.every((item) => !("forkable" in item))).toBe(true);
    expect(codexHistoryAvailable(null)).toBe(false);
  });

  test("requires the exact prefix, including an intentional empty prefix", () => {
    const request = { threadId: "parent", beforeTurnId: "second" };
    const expected = codexForkPrefix(request, ["first", "second"]);
    expect(expected).toEqual(["first"]);
    expect(validCodexFork(request, { thread: { id: "copy", turns: [] } }, expected)).toBe(false);
    expect(
      validCodexFork(request, { thread: { id: "copy", turns: [{ id: "other" }] } }, expected),
    ).toBe(false);
    expect(validCodexFork(request, { thread: { id: "parent", turns: [first] } }, expected)).toBe(
      false,
    );
    expect(validCodexFork(request, { thread: { id: "copy", turns: [first] } }, expected)).toBe(
      true,
    );
    expect(
      validCodexFork(
        { ...request, beforeTurnId: "first" },
        { thread: { id: "copy", turns: [] } },
        [],
      ),
    ).toBe(true);
  });

  test("replays validated rewind and ignores an announced child until its response passes", () => {
    const h = harness();
    const original = h.model.items;
    const fork = { threadId: "parent", beforeTurnId: "second" };
    for (const [id, turns] of [
      ["wrong", []],
      ["copy", [first]],
    ] as const) {
      h.send("read", "thread/read", { threadId: "parent", includeTurns: true });
      h.reply("read", { thread: { id: "parent", turns: [first, second] } });
      h.send("fork", "thread/fork", fork);
      h.line("out", { method: "thread/started", params: { thread: { id } } });
      expect(h.model.threadId).toBe("parent");
      h.reply("fork", { thread: { id, turns } });
      if (id === "wrong") expect(h.model.items).toBe(original);
    }
    expect(h.model.threadId).toBe("copy");
    expect(h.model.items).toHaveLength(2);
    expect(h.model.items[0]).toMatchObject({ kind: "user", text: "prompt", rewindable: true });
  });

  test("marks existing peer items through a watch replacement at turn completion", () => {
    const h = harness();
    h.line("out", {
      method: "turn/started",
      params: { threadId: "parent", turn: { id: "third" } },
    });
    for (const item of [user("third prompt"), answer("third answer")]) {
      h.line("out", {
        method: "item/completed",
        params: { threadId: "parent", turnId: "third", item },
      });
    }
    const before = sentOf(h.source(), 0);
    h.line("out", {
      method: "turn/completed",
      params: { threadId: "parent", turn: { id: "third", status: "completed" } },
    });
    const change = changesOf(before, sentOf(h.source(), 0), true);
    expect(change?.items.map(({ item }) => item)).toMatchObject([
      { kind: "user", forkable: true, rewindable: true },
      { kind: "assistant", forkable: true },
    ]);
    expect(
      appendsOf(
        { kind: "assistant", key: "a", messageId: "t", blocks: [{ type: "text", text: "a" }] },
        {
          kind: "assistant",
          key: "a",
          messageId: "t",
          blocks: [{ type: "text", text: "ab" }],
          forkable: true,
        },
        0,
      ),
    ).toBeNull();
  });

  test("blocks pending approvals, queued input, and turn-changing requests", () => {
    const state = emptyTabState();
    expect(codexHistoryBusy(state)).toBe(false);
    expect(codexHistoryBusy({ ...state, queue: [{ id: "q", text: "next", images: [] }] })).toBe(
      true,
    );
    expect(
      codexHistoryBusy({
        ...state,
        model: {
          ...state.model,
          outgoing: { i: { subtype: "turn/start", request: {} } },
        },
      }),
    ).toBe(true);
  });

  test("lists only native children of the parent and serves their data outside the parent page", () => {
    const h = harness();
    h.send("children", "thread/list", { parentThreadId: "parent" });
    h.reply("children", {
      data: [
        {
          id: "child",
          parentThreadId: "parent",
          agentNickname: "Worker",
          status: { type: "idle" },
        },
        { id: "foreign", parentThreadId: "someone else" },
      ],
    });
    h.send("childread", "thread/read", { threadId: "child", includeTurns: true });
    h.reply("childread", { thread: { id: "child", turns: [first] } });
    expect(Object.keys(h.model.tasks)).toEqual(["child"]);
    expect(h.model.nativeTranscripts?.child.map((item) => item.kind)).toEqual([
      "user",
      "assistant",
    ]);
    expect(chatPageOf(h.source(), { limit: 1 }).agentItems.child).toHaveLength(1);
  });
});
