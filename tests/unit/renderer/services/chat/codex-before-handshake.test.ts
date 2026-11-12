/**
 * A Codex program takes no request before it knows the app (initialize):
 * one sent before is refused with "Not initialized", which a tab showed as
 * an error. What a tab asks as it opens (its list of threads, its
 * defaults) waits for the introduction. The real ipc client is spread
 * under a spy, so later files keep its other exports.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";

// The version the app tells Codex it is.
(globalThis as { __APP_VERSION__?: string }).__APP_VERSION__ ??= "0.0.0";

type Message = Record<string, unknown>;
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
type Controller = InstanceType<typeof CodexController>;

let seq = 0;
let lineSeq = 5000;
const live: Controller[] = [];
const sent: Message[] = [];

afterEach(() => {
  for (const c of live.splice(0)) c.dispose();
  codex = undefined;
  sent.length = 0;
});

/** A tab whose program is not running and answers initialize a while after it is asked. */
function tab(): Controller {
  const c = new CodexController({
    workspaceId: "ws-codex-handshake",
    tabId: `h${++seq}`,
    cwd: "/p",
    threadId: "t1",
  });
  live.push(c);
  codex = (message) => {
    sent.push(message);
    if (message.id === undefined) return;
    const result =
      message.method === "thread/resume"
        ? { thread: { id: "t1" } }
        : message.method === "thread/list"
          ? { data: [] }
          : message.method === "config/read"
            ? { config: {} }
            : {};
    const answer = () => {
      c.receive({ seq: ++lineSeq, dir: "in", message } as never);
      c.receive({ seq: ++lineSeq, dir: "out", message: { id: message.id, result } } as never);
    };
    if (message.method === "initialize") setTimeout(answer, 30);
    else queueMicrotask(answer);
  };
  useChatStore.getState().update(c.key, (prev) => ({ ...prev, phase: "ended" }));
  return c;
}

const order = () => sent.map((m) => m.method);

describe("what a Codex tab asks as its program starts", () => {
  test("goes after the program knows the app", async () => {
    const c = tab();
    await Promise.all([c.listThreads(), c.readDefaults()]);
    const methods = order();
    const known = methods.indexOf("initialized");
    expect(known).toBeGreaterThan(methods.indexOf("initialize"));
    expect(methods.indexOf("thread/list")).toBeGreaterThan(known);
    expect(methods.indexOf("config/read")).toBeGreaterThan(known);
  });

  test("goes at once to a program that knows the app already", async () => {
    const c = tab();
    await c.readDefaults();
    // Its start line, which the agent sends, says it runs.
    useChatStore
      .getState()
      .update(c.key, (prev) => ({ ...prev, model: { ...prev.model, process: "running" } }));
    sent.length = 0;
    await c.listThreads();
    expect(order()).toEqual(["thread/list"]);
  });
});
