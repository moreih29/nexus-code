import { describe, expect, test } from "bun:test";
import {
  appendCodexThreadPage,
  emptyCodexThreadPages,
  readCodexThread,
  THREAD_READ_TURNS,
} from "../../../../../src/renderer/services/chat/codex/history";
import { codexThreadModel } from "../../../../../src/renderer/services/chat/codex/model";
import {
  mergeRunLines,
  NO_RUN_LINES,
} from "../../../../../src/renderer/services/chat/print-run-transcript";

const read = (over: Partial<Parameters<typeof mergeRunLines>[1]>) => ({
  found: true,
  lines: [],
  next: 0,
  reset: false,
  truncated: false,
  ...over,
});

describe("a claude run's transcript, read on", () => {
  test("a later read goes on from the earlier one's end", () => {
    const first = mergeRunLines(NO_RUN_LINES, read({ lines: ["a", "b"], next: 20 }));
    expect(first).toEqual({ found: true, lines: ["a", "b"], next: 20, truncated: false });
    const second = mergeRunLines(first, read({ lines: ["c"], next: 30 }));
    expect(second.lines).toEqual(["a", "b", "c"]);
    expect(second.next).toBe(30);
  });

  test("a read with nothing new changes nothing", () => {
    const first = mergeRunLines(NO_RUN_LINES, read({ lines: ["a"], next: 10 }));
    expect(mergeRunLines(first, read({ next: 10 }))).toBe(first);
  });

  test("a file written over is read anew", () => {
    const first = mergeRunLines(NO_RUN_LINES, read({ lines: ["a", "b"], next: 20 }));
    expect(mergeRunLines(first, read({ lines: ["z"], next: 5, reset: true })).lines).toEqual(["z"]);
  });

  test("a read that finds none keeps what was read", () => {
    const first = mergeRunLines(NO_RUN_LINES, read({ lines: ["a"], next: 10 }));
    expect(mergeRunLines(first, read({ found: false }))).toBe(first);
    expect(mergeRunLines(NO_RUN_LINES, read({ found: false }))).toBe(NO_RUN_LINES);
  });

  test("a start that was cut stays cut", () => {
    const first = mergeRunLines(NO_RUN_LINES, read({ lines: ["a"], next: 10, truncated: true }));
    expect(mergeRunLines(first, read({ lines: ["b"], next: 20 })).truncated).toBe(true);
  });
});

const turn = (id: string, text: string) => ({
  id,
  status: "completed",
  items: [
    { type: "userMessage", id: `u-${id}`, content: [{ type: "text", text, text_elements: [] }] },
    { type: "agentMessage", id: `a-${id}`, text: `re: ${text}` },
  ],
});

describe("a codex run's thread, read without loading it", () => {
  test("pages go on to the one with no cursor", async () => {
    const asked: Array<{ method: string; params: Record<string, unknown> }> = [];
    const thread = await readCodexThread(
      async (method, params) => {
        asked.push({ method, params });
        return params.cursor === "c1"
          ? { data: [turn("t2", "two")], nextCursor: null }
          : { data: [turn("t1", "one")], nextCursor: "c1" };
      },
      "th-1",
      "0.170.0",
    );
    expect(thread?.turns.map((t) => (t as { id: string }).id)).toEqual(["t1", "t2"]);
    expect(asked.map((a) => a.method)).toEqual(["thread/turns/list", "thread/turns/list"]);
    expect(asked[0]?.params).toEqual({
      threadId: "th-1",
      sortDirection: "asc",
      itemsView: "full",
      limit: THREAD_READ_TURNS,
    });
    expect(asked[1]?.params.cursor).toBe("c1");
  });

  test("an older server answers in one read, which loads nothing", async () => {
    const asked: string[] = [];
    const thread = await readCodexThread(
      async (method, params) => {
        asked.push(`${method} ${JSON.stringify(params)}`);
        return { thread: { id: "th-1", turns: [turn("t1", "one")] } };
      },
      "th-1",
      "0.166.0",
    );
    expect(asked).toEqual(['thread/read {"threadId":"th-1","includeTurns":true}']);
    expect(thread?.turns).toHaveLength(1);
  });

  test("pages that do not go on are not a thread", async () => {
    expect(
      await readCodexThread(
        async () => ({ data: [turn("t1", "one")], nextCursor: "same" }),
        "t",
        "0.170.0",
      ),
    ).toBeNull();
    expect(await readCodexThread(async () => ({}), "t", "0.170.0")).toBeNull();
    const pages = appendCodexThreadPage(emptyCodexThreadPages(), { data: [], nextCursor: "c" });
    expect(pages).toBeUndefined();
  });

  test("its turns show as a resumed tab's do, with nothing to fork or run", () => {
    const model = codexThreadModel({ id: "th-1", turns: [turn("t1", "one"), turn("t2", "two")] });
    expect(model.threadId).toBe("th-1");
    expect(model.running).toBe(false);
    expect(model.forkSource).toBeUndefined();
    expect(model.items.map((item) => item.kind)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
    expect(model.items.some((item) => "forkable" in item && item.forkable)).toBe(false);
  });
});
