import { describe, expect, test } from "bun:test";
import {
  appendCodexThreadPage,
  emptyCodexThreadPages,
  readCodexThread,
  THREAD_READ_TURNS,
} from "../../../../../src/renderer/services/chat/codex/history";
import { codexThreadModel } from "../../../../../src/renderer/services/chat/codex/model";
import type { ChatModel } from "../../../../../src/renderer/services/chat/model";
import {
  type CodexRunReader,
  keepRunReader,
  mergeRunLines,
  NO_RUN_LINES,
  RUN_READ_INTERVAL_MS,
  RUN_READER_AGAIN_MS,
  RUN_READER_ATTEMPTS,
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

describe("a codex run's reader kept up for its pane", () => {
  const MODEL = { items: [] } as unknown as ChatModel;
  function kept(running = true, reached: Array<boolean | "failed"> = []) {
    const state = { running, ups: 0, opens: 0 };
    const reach = [...reached];
    const readers: Array<{ die(): void; closed: boolean; model: ChatModel | null }> = [];
    const waits: Array<{ run(): void; ms: number }> = [];
    const keeper = keepRunReader({
      open: async (onDead) => {
        state.opens += 1;
        const next = reach.shift();
        if (next === false) return "none";
        if (next === "failed") return "failed";
        const made = {
          closed: false,
          dead: false,
          model: MODEL as ChatModel | null,
          die: () => {},
        };
        const reader: CodexRunReader = {
          get dead() {
            return made.dead;
          },
          read: async () => (made.dead || made.closed ? null : made.model),
          close: () => {
            made.closed = true;
          },
        };
        made.die = () => {
          made.dead = true;
          onDead();
        };
        readers.push(made);
        return reader;
      },
      running: () => state.running,
      onUp: () => {
        state.ups += 1;
      },
      timers: {
        set: (run, ms) => {
          const wait = { run, ms };
          waits.push(wait);
          return wait;
        },
        clear: (wait) => {
          const at = waits.indexOf(wait as (typeof waits)[number]);
          if (at >= 0) waits.splice(at, 1);
        },
      },
    });
    const settled = () => new Promise((resolve) => setTimeout(resolve, 0));
    const pass = async () => {
      const wait = waits.shift();
      wait?.run();
      await settled();
      return wait?.ms;
    };
    return { keeper, state, reach, readers, waits, settled, pass };
  }

  test("one that did not start is asked for again for as long as the run goes on", async () => {
    const k = kept(true, [false, false, false, false, false, true]);
    await k.settled();
    for (let n = 0; n < 5; n += 1) expect(await k.pass()).toBe(RUN_READ_INTERVAL_MS);
    expect(k.state.opens).toBe(6);
    expect(k.state.ups).toBe(1);
    expect(await k.keeper.read()).toBe(MODEL);
    expect(k.waits).toEqual([]);
  });

  test("after the run ended, one that does not start is asked for a few times only", async () => {
    const k = kept(false, Array(10).fill(false));
    await k.settled();
    let passed = 0;
    while (k.waits.length > 0) {
      expect(await k.pass()).toBe(RUN_READER_AGAIN_MS);
      passed += 1;
    }
    expect(passed).toBe(RUN_READER_ATTEMPTS);
    expect(await k.keeper.read()).toBeNull();
  });

  test("one that was started and did not come up is started a few times only", async () => {
    const k = kept(true, Array(10).fill("failed"));
    await k.settled();
    let passed = 0;
    while (k.waits.length > 0) {
      expect(await k.pass()).toBe(RUN_READER_AGAIN_MS);
      passed += 1;
    }
    expect(passed).toBe(RUN_READER_ATTEMPTS);
    expect(k.state.opens).toBe(RUN_READER_ATTEMPTS + 1);
    expect(k.state.ups).toBe(0);
  });

  test("one that ended is closed and another started, counted anew after a read", async () => {
    const k = kept();
    await k.settled();
    for (let n = 0; n < RUN_READER_ATTEMPTS + 2; n += 1) {
      expect(await k.keeper.read()).toBe(MODEL);
      k.readers[n]?.die();
      expect(k.readers[n]?.closed).toBe(true);
      expect(await k.keeper.read()).toBeNull();
      expect(await k.pass()).toBe(RUN_READER_AGAIN_MS);
    }
    expect(k.state.ups).toBe(RUN_READER_ATTEMPTS + 3);
    for (;;) {
      k.readers[k.readers.length - 1]?.die();
      if (k.waits.length === 0) break;
      await k.pass();
    }
    expect(k.readers.length).toBe(RUN_READER_ATTEMPTS + 2 + RUN_READER_ATTEMPTS);
    expect(k.readers.every((reader) => reader.closed)).toBe(true);
  });

  test("closing ends the reader and what was waited for", async () => {
    const k = kept(true, [false]);
    await k.settled();
    expect(k.waits).toHaveLength(1);
    k.keeper.close();
    expect(k.waits).toEqual([]);

    const up = kept();
    await up.settled();
    up.keeper.close();
    expect(up.readers[0]?.closed).toBe(true);
    up.readers[0]?.die();
    expect(up.waits).toEqual([]);
  });
});
