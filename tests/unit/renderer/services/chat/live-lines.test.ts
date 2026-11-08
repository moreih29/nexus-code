/**
 * A tab asking for its log again takes the log's lines first: a new line
 * that came before them waits, or the model would skip them as seen and lose
 * the program it started.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { ChatController } from "../../../../../src/renderer/services/chat/controller";
import { LiveLines } from "../../../../../src/renderer/services/chat/live-lines";
import type { ChatLine } from "../../../../../src/renderer/services/chat/model";

const line = (seq: number, replay = false): ChatLine => ({
  seq,
  dir: "out",
  message: { type: "system", subtype: "hook_started" },
  ...(replay ? { replay: true } : {}),
});

describe("LiveLines", () => {
  test("lets lines by when not held", () => {
    const live = new LiveLines();
    expect(live.holds(line(1))).toBe(false);
    expect(live.release()).toEqual([]);
  });

  test("holds new lines, never the log's, until released", () => {
    const live = new LiveLines();
    live.hold();
    expect(live.holds(line(5))).toBe(true);
    expect(live.holds(line(3, true))).toBe(false);
    expect(live.holds(line(6))).toBe(true);
    expect(live.release().map((l) => l.seq)).toEqual([5, 6]);
    expect(live.holds(line(7))).toBe(false);
  });

  test("a hold within a hold lets them go at the last release", () => {
    const live = new LiveLines();
    live.hold();
    live.hold();
    live.holds(line(5));
    expect(live.release()).toEqual([]);
    expect(live.release().map((l) => l.seq)).toEqual([5]);
  });
});

const W = globalThis as { window?: unknown };
const before = W.window;
afterEach(() => {
  W.window = before;
});

describe("a Claude tab's replay", () => {
  test("a new line before the log's keeps the program the log starts", async () => {
    const c = new ChatController({ workspaceId: "ws-live", tabId: "t-live", cwd: "/p" });
    const start: ChatLine = { seq: 13, dir: "sys", message: { event: "start", pid: 1 } };
    W.window = {
      ipc: {
        call: async (_channel: string, method: string) => {
          if (method !== "replay") throw new Error(`unexpected ${method}`);
          // The program's next line comes first; the log's follow.
          c.receive(line(14));
          setTimeout(() => {
            c.receive({ ...start, replay: true });
            c.receive(line(14, true));
          }, 5);
          return { found: true, running: true, truncated: false, lastSeq: 14 };
        },
      },
    };
    await c.resync();
    expect(c.state.model.process).toBe("running");
    expect(c.state.model.lastSeq).toBe(14);
    // Lines that come after go on as ever.
    c.receive(line(15));
    c.flushNow();
    expect(c.state.model.lastSeq).toBe(15);
    c.dispose();
  });
});
