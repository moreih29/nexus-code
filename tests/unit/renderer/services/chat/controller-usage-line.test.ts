/**
 * What the line under the composer asks Claude for: the context after each
 * turn, whoever began it and the tab shown or not, and the plan's usage,
 * for its limits alone, through the profile's store, which asks once for
 * all its tabs. The real ipc client is spread under a spy, so later files
 * keep its other exports.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const sent: Record<string, unknown>[] = [];

const realIpc = await import("../../../../../src/renderer/ipc/client");
mock.module("../../../../../src/renderer/ipc/client", () => ({
  ...realIpc,
  ipcCallResult: (
    _channel: string,
    method: string,
    args: { message?: Record<string, unknown> },
  ) => {
    if (method === "send" && args.message) sent.push(args.message);
    return Promise.resolve({ ok: true, value: undefined });
  },
}));

const { ChatController } = await import("../../../../../src/renderer/services/chat/controller");
const { useChatStore } = await import("../../../../../src/renderer/services/chat/store");
const { resetPlanUsage } = await import("../../../../../src/renderer/services/chat/plan-usage");
type ChatLine = import("../../../../../src/renderer/services/chat/model").ChatLine;
type Controller = InstanceType<typeof ChatController>;

let seq = 0;
const live: Controller[] = [];

/** A tab whose program runs, of a Claude Code `version`. */
function running(version = "2.1.321"): Controller {
  const c = new ChatController({ workspaceId: "ws-usage", tabId: `t${++seq}`, cwd: "/p" }, {});
  useChatStore.getState().update(c.key, (prev) => ({
    ...prev,
    phase: "ready",
    version,
    model: { ...prev.model, process: "running" },
  }));
  live.push(c);
  return c;
}

const result = (replay = false): ChatLine => ({
  seq: ++seq,
  dir: "out",
  message: { type: "result", subtype: "success", is_error: false, session_id: "s1" },
  ...(replay ? { replay: true } : {}),
});

/** The control requests written so far, each as its subtype and what it was asked with. */
function asked(): Record<string, unknown>[] {
  return sent
    .filter((message) => message.type === "control_request")
    .map((message) => message.request as Record<string, unknown>);
}

beforeEach(() => resetPlanUsage());

afterEach(() => {
  for (const c of live.splice(0)) c.dispose();
  sent.length = 0;
});

const USAGE = { subtype: "get_usage", skip_behaviors: true };
/** Lets the asks waiting on the program's initialize go out. */
const settle = async () => {
  for (let i = 0; i < 4; i++) await Promise.resolve();
};

describe("the line under the composer", () => {
  test("asks for the context as each turn ends, with no one looking at the tab, and the profile's usage", () => {
    const c = running();
    c.receive(result());
    expect(asked()).toEqual([{ subtype: "get_context_usage" }, USAGE]);
  });

  test("two tabs of one profile ending their turns ask for its usage once", () => {
    const a = running();
    const b = running();
    a.receive(result());
    b.receive(result());
    expect(asked().filter((r) => r.subtype === "get_usage")).toEqual([USAGE]);
  });

  test("asks again after a compaction, mid-turn", () => {
    const c = running();
    c.receive({
      seq: ++seq,
      dir: "out",
      message: { type: "system", subtype: "compact_boundary", session_id: "s1" },
    });
    expect(asked()).toEqual([{ subtype: "get_context_usage" }]);
  });

  test("a turn's end replayed from the log asks for nothing", () => {
    const c = running();
    c.receive(result(true));
    expect(asked()).toEqual([]);
  });

  test("asks for the plan's limits alone as it is shown, not again while the profile's are being fetched", async () => {
    const c = running();
    c.refreshUsageLine();
    await settle();
    c.refreshUsageLine();
    await settle();
    expect(asked()).toEqual([
      { subtype: "get_context_usage" },
      USAGE,
      { subtype: "get_context_usage" },
    ]);
  });

  test("an older Claude Code is asked for its usage as before", async () => {
    const c = running("2.1.300");
    c.refreshUsageLine();
    await settle();
    expect(asked()).toContainEqual({ subtype: "get_usage" });
  });

  test("a program not running is asked nothing", () => {
    const c = new ChatController({ workspaceId: "ws-usage", tabId: `t${++seq}`, cwd: "/p" }, {});
    live.push(c);
    c.receive(result());
    c.refreshUsageLine();
    expect(asked()).toEqual([]);
  });
});
