/**
 * The model and effort picked in a Codex tab are the tab's, as a Claude
 * tab's are: the tab is told to keep them, and after a restart its chips
 * show them over the thread's own and its next turn is sent with them.
 * The real ipc client is spread under a spy, so later files keep its
 * other exports.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";

// The version the app tells Codex it is.
(globalThis as { __APP_VERSION__?: string }).__APP_VERSION__ ??= "0.0.0";

type Message = Record<string, unknown> & { params?: Record<string, unknown> };
/** A Codex program that comes up, answering what is sent to it as the test says. */
let codex: ((message: Message) => void) | undefined;

const realIpc = await import("../../../../../src/renderer/ipc/client");
mock.module("../../../../../src/renderer/ipc/client", () => ({
  ...realIpc,
  ipcListen: () => () => {},
  ipcCallResult: (_channel: string, method: string, args: Record<string, unknown>) => {
    if (method === "send") codex?.(args.message as Message);
    if (method === "codexStart") {
      return Promise.resolve({
        ok: true,
        value: { ok: true, pid: 1, attached: false, version: null },
      });
    }
    return Promise.resolve({ ok: true, value: undefined });
  },
}));

const { CodexController } = await import(
  "../../../../../src/renderer/services/chat/codex-controller"
);
const { useChatStore } = await import("../../../../../src/renderer/services/chat/store");
const { useTabsStore } = await import("../../../../../src/renderer/state/stores/tabs");
type Controller = InstanceType<typeof CodexController>;

let seq = 0;
let lineSeq = 1000;
const live: Controller[] = [];
const sent: Message[] = [];

afterEach(() => {
  for (const c of live.splice(0)) c.dispose();
  codex = undefined;
  sent.length = 0;
});

/**
 * A tab whose program comes up and goes on with thread "t1", which ran
 * on gpt-5.5 at high effort; every request is echoed and answered.
 */
function tab(chosen?: { model?: string; effort?: string }, onChosen?: (pick: unknown) => void) {
  const c = new CodexController(
    {
      workspaceId: "ws-codex-chosen",
      tabId: `c${++seq}`,
      cwd: "/p",
      threadId: "t1",
      ...(chosen ? { chosen } : {}),
    },
    onChosen ? { onChosen } : {},
  );
  live.push(c);
  codex = (message) => {
    sent.push(message);
    if (message.id === undefined) return;
    const result =
      message.method === "thread/resume"
        ? { thread: { id: "t1" }, model: "gpt-5.5", reasoningEffort: "high" }
        : message.method === "turn/start"
          ? { turn: { id: "turn-1" } }
          : message.method === "config/read"
            ? { config: {} }
            : {};
    queueMicrotask(() => {
      c.receive({ seq: ++lineSeq, dir: "in", message } as never);
      c.receive({ seq: ++lineSeq, dir: "out", message: { id: message.id, result } } as never);
    });
  };
  // Its program is not running: what the tab does next starts it.
  useChatStore.getState().update(c.key, (prev) => ({ ...prev, phase: "ended" }));
  return c;
}

function shown(c: Controller): { model?: unknown; effort?: unknown } {
  const { model, effort } = c.state.model as Record<string, unknown>;
  return { model, effort };
}

describe("the model and effort picked in a Codex tab", () => {
  test("are told to the tab to keep", async () => {
    const picks: unknown[] = [];
    const c = tab(undefined, (pick) => picks.push(pick));
    await c.setModel("gpt-5.4-mini");
    await c.setEffort("low");
    expect(picks).toEqual([{ model: "gpt-5.4-mini" }, { effort: "low" }]);
    expect(c.inheritedChoice()).toEqual({ model: "gpt-5.4-mini", effort: "low" });
  });

  test("show over the thread's own once its program is back, and go with its next turn", async () => {
    const c = tab({ model: "gpt-5.4-mini", effort: "low" });
    await c.readDefaults();
    await Bun.sleep(40);
    expect(shown(c)).toEqual({ model: "gpt-5.4-mini", effort: "low" });
    await c.send("hi");
    const turn = sent.find((m) => m.method === "turn/start");
    expect(turn?.params).toMatchObject({ threadId: "t1", model: "gpt-5.4-mini", effort: "low" });
  });

  test("are forgotten once a turn takes them: the thread holds them from then on", async () => {
    const picks: unknown[] = [];
    const c = tab({ model: "gpt-5.4-mini" }, (pick) => picks.push(pick));
    await c.readDefaults();
    await Bun.sleep(40);
    await c.send("hi");
    expect(picks).toEqual([{}]);
    // A second turn has nothing of its own to send, nor to forget.
    await Bun.sleep(40);
    await c.send("again");
    const turns = sent.filter((m) => m.method === "turn/start");
    expect(turns[1]?.params?.model).toBeUndefined();
    expect(picks).toEqual([{}]);
  });

  test("leave a tab without a pick on the thread's", async () => {
    const c = tab();
    await c.readDefaults();
    await Bun.sleep(40);
    expect(shown(c)).toEqual({ model: "gpt-5.5", effort: "high" });
    await c.send("hi");
    const turn = sent.find((m) => m.method === "turn/start");
    expect(turn?.params?.model).toBeUndefined();
    expect(turn?.params?.effort).toBeUndefined();
  });
});

describe("the pick a Codex tab keeps", () => {
  test("goes on with its thread until a turn takes it, and not to another profile", () => {
    const tabs = () => useTabsStore.getState();
    const t = tabs().createTab("ws-codex-chosen-store", { type: "codex", props: { cwd: "/p" } });
    const props = () => tabs().byWorkspace["ws-codex-chosen-store"]?.[t.id]?.props;
    tabs().setChatChosen("ws-codex-chosen-store", t.id, { model: "gpt-5.4-mini" });
    tabs().setChatChosen("ws-codex-chosen-store", t.id, { effort: "low" });
    tabs().setCodexThread("ws-codex-chosen-store", t.id, "t1");
    expect(props()).toEqual({
      cwd: "/p",
      threadId: "t1",
      chosen: { model: "gpt-5.4-mini", effort: "low" },
    });
    tabs().setChatChosen("ws-codex-chosen-store", t.id, {});
    expect(props()).toEqual({ cwd: "/p", threadId: "t1" });
    tabs().setChatChosen("ws-codex-chosen-store", t.id, { effort: "low" });
    tabs().setChatProfile("ws-codex-chosen-store", t.id, "work");
    expect(props()).toEqual({ cwd: "/p", profileId: "work" });
  });
});
