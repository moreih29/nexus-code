import { afterEach, expect, mock, test } from "bun:test";

(globalThis as { __APP_VERSION__?: string }).__APP_VERSION__ ??= "0.0.0";

type Message = Record<string, unknown> & { params?: Record<string, unknown> };
const sent: Message[] = [];
let respond: ((message: Message) => void) | undefined;
let replay: () => unknown = () => ({ found: true, running: true, lastSeq: 0 });

const realIpc = await import("../../../../../src/renderer/ipc/client");
mock.module("../../../../../src/renderer/ipc/client", () => ({
  ...realIpc,
  ipcListen: () => () => {},
  ipcCallResult: (_channel: string, method: string, args: Record<string, unknown>) => {
    if (method === "send") {
      const message = args.message as Message;
      sent.push(message);
      respond?.(message);
    }
    if (method === "replay") return Promise.resolve({ ok: true, value: replay() });
    if (method === "codexStart") {
      return Promise.resolve({
        ok: true,
        value: { ok: true, pid: 1, attached: false, version: null },
      });
    }
    return Promise.resolve({ ok: true, value: undefined });
  },
}));

const { ChatController } = await import(
  "../../../../../src/renderer/services/chat/claude/controller"
);
const { CodexController } = await import(
  "../../../../../src/renderer/services/chat/codex/controller"
);
const { useChatStore } = await import("../../../../../src/renderer/services/chat/store");

type Tab = InstanceType<typeof ChatController> | InstanceType<typeof CodexController>;

let nextTab = 0;
let lineSeq = 1000;
const live: Tab[] = [];

afterEach(() => {
  for (const c of live.splice(0)) c.dispose();
  sent.length = 0;
  respond = undefined;
  replay = () => ({ found: true, running: true, lastSeq: 0 });
});

interface Harness {
  tab: Tab;
  delivered(): string[];
  turnEnd(): Message;
}

async function claudeTab(): Promise<Harness> {
  const tab = new ChatController({
    workspaceId: "ws-reconnect",
    tabId: `claude-${++nextTab}`,
    cwd: "/p",
    sessionId: "s",
  });
  live.push(tab);
  respond = (message) => {
    if (message.type !== "user") return;
    queueMicrotask(() => tab.receive({ seq: ++lineSeq, dir: "in", message } as never));
  };
  await tab.open();
  tab.receive({
    seq: ++lineSeq,
    dir: "in",
    message: { type: "user", uuid: "first", message: { content: "Start" } },
  });
  tab.flushNow();
  return {
    tab,
    delivered: () =>
      sent.flatMap((message) =>
        message.type === "user" ? [String((message.message as { content: unknown }).content)] : [],
      ),
    turnEnd: () => ({ type: "result", subtype: "success", is_error: false, result: "done" }),
  };
}

async function codexTab(): Promise<Harness> {
  const tab = new CodexController({
    workspaceId: "ws-reconnect",
    tabId: `codex-${++nextTab}`,
    cwd: "/p",
    threadId: "t1",
  });
  live.push(tab);
  respond = (message) => {
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
      if (message.method === "initialize") {
        tab.receive({ seq: ++lineSeq, dir: "sys", message: { event: "start", pid: 1 } } as never);
      }
      tab.receive({ seq: ++lineSeq, dir: "in", message } as never);
      tab.receive({ seq: ++lineSeq, dir: "out", message: { id: message.id, result } } as never);
    });
  };
  useChatStore.getState().update(tab.key, (prev) => ({ ...prev, phase: "ended" }));
  await tab.sendWithTiming("Start", [], "next", undefined, undefined, "first-id");
  sent.length = 0;
  return {
    tab,
    delivered: () =>
      sent.flatMap(({ method, params }) =>
        method === "turn/start" || method === "turn/steer"
          ? [(params?.input as { text: string }[])[0]?.text ?? ""]
          : [],
      ),
    turnEnd: () => ({
      method: "turn/completed",
      params: { threadId: "t1", turn: { id: "turn-1", status: "completed" } },
    }),
  };
}

test.each([
  ["claude", claudeTab],
  ["codex", codexTab],
] as const)("%s sends the next held message once it reconnects after its turn ended", async (_agent, open) => {
  const { tab, delivered, turnEnd } = await open();
  expect(tab.state.model.running).toBe(true);
  tab.enqueue("after the turn");
  await Bun.sleep(0);
  expect(delivered()).toEqual([]);

  tab.held();
  tab.enqueue("while away");
  await Bun.sleep(0);
  expect(delivered()).toEqual([]);

  replay = () => {
    const seq = ++lineSeq;
    tab.receive({ seq, dir: "out", replay: true, message: turnEnd() } as never);
    return { found: true, running: true, lastSeq: seq };
  };
  await tab.resync();
  await Bun.sleep(0);

  expect(tab.state.phase).toBe("ready");
  expect(delivered()).toEqual(["after the turn"]);
  expect(tab.state.queue.map(({ text, status }) => ({ text, status }))).toEqual([
    { text: "while away", status: undefined },
  ]);
});

test.each([
  ["claude", claudeTab],
  ["codex", codexTab],
] as const)("%s keeps a message held while away and sends it once it reconnects", async (_agent, open) => {
  const { tab, delivered, turnEnd } = await open();
  const seq = ++lineSeq;
  tab.receive({ seq, dir: "out", message: turnEnd() } as never);
  tab.flushNow();
  expect(tab.state.model.running).toBe(false);

  tab.held();
  tab.enqueue("while away");
  await Bun.sleep(0);
  expect(delivered()).toEqual([]);
  expect(tab.state.queue.map(({ text, status }) => ({ text, status }))).toEqual([
    { text: "while away", status: undefined },
  ]);

  replay = () => ({ found: true, running: true, lastSeq: seq });
  await tab.resync();
  await Bun.sleep(0);

  expect(tab.state.phase).toBe("ready");
  expect(delivered()).toEqual(["while away"]);
  expect(tab.state.queue).toEqual([]);
});
