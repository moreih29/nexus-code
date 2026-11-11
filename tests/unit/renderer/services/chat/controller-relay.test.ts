/**
 * A message another agent sends a chat tab through the nexus command: its
 * agent reads a line before it that says who sent it, and the tab keeps who
 * did by the message's id before the message is written, so it never shows
 * as the user's. The real ipc client is spread under a spy.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import type { RelayedMessage } from "../../../../../src/shared/chat/relay";

(globalThis as { __APP_VERSION__?: string }).__APP_VERSION__ ??= "0.0.0";

const steps: string[] = [];
const written: Record<string, unknown>[] = [];
let answer: ((message: Record<string, unknown>) => void) | undefined;

const realIpc = await import("../../../../../src/renderer/ipc/client");
mock.module("../../../../../src/renderer/ipc/client", () => ({
  ...realIpc,
  ipcListen: () => () => {},
  ipcCallResult: (_channel: string, method: string, args: Record<string, unknown>) => {
    if (method === "send") {
      const message = args.message as Record<string, unknown>;
      written.push(message);
      steps.push(`send:${String(message.method ?? message.type)}`);
      answer?.(message);
    }
    return Promise.resolve({ ok: true, value: undefined });
  },
}));

const { ChatController } = await import("../../../../../src/renderer/services/chat/controller");
const { CodexController } = await import(
  "../../../../../src/renderer/services/chat/codex-controller"
);
const { useChatStore } = await import("../../../../../src/renderer/services/chat/store");
const { useTabsStore } = await import("../../../../../src/renderer/state/stores/tabs");

const FROM = { kind: "tab", agent: "codex", name: "Plan", workspaceId: "ws", tabId: "t0" } as const;
const HEADER =
  '[nexus] The "Plan" tab (Codex) sent this, not the user. Your answer here is what it reads.';

let seq = 0;
const live: { dispose: () => void }[] = [];

afterEach(() => {
  for (const c of live.splice(0)) c.dispose();
  steps.length = 0;
  written.length = 0;
  answer = undefined;
});

describe("a message another agent sends a Claude tab", () => {
  test("is led by the line, kept by its uuid before it is written, and titles the tab by itself", async () => {
    const records: RelayedMessage[] = [];
    const titles: string[] = [];
    const c = new ChatController(
      { workspaceId: "ws-relay", tabId: `t${++seq}`, cwd: "/p", sessionId: "s" },
      {
        onRelayed: (record) => {
          records.push(record);
          steps.push("relayed");
        },
        onFirstMessage: (text) => titles.push(text),
      },
    );
    live.push(c);
    useChatStore.getState().update(c.key, (prev) => ({
      ...prev,
      phase: "ready",
      model: { ...prev.model, process: "running" },
    }));
    await c.send("Run the tests.", [], FROM);
    const line = written.find((m) => m.type === "user") as {
      uuid: string;
      message: { content: string };
    };
    expect(line.message.content).toBe(`${HEADER}\n\nRun the tests.`);
    expect(records).toEqual([{ id: line.uuid, from: FROM, at: expect.any(Number) }]);
    expect(steps.indexOf("relayed")).toBeLessThan(steps.indexOf("send:user"));
    expect(titles).toEqual(["Run the tests."]);
    // The user's own message is theirs: no line, no record.
    await c.send("Thanks");
    expect((written.at(-1) as { message: { content: string } }).message.content).toBe("Thanks");
    expect(records).toHaveLength(1);
  });
});

describe("a message another agent sends a Codex tab", () => {
  test("is kept by its client id, then with the turn it went into", async () => {
    const records: RelayedMessage[] = [];
    const c = new CodexController(
      { workspaceId: "ws-relay", tabId: `x${++seq}`, cwd: "/p", threadId: "th" },
      { onRelayed: (record) => records.push(record) },
    );
    live.push(c);
    useChatStore.getState().update(c.key, (prev) => ({
      ...prev,
      phase: "ready",
      model: { ...prev.model, process: "running", threadId: "th" } as typeof prev.model,
    }));
    (c as unknown as { ready: Promise<boolean> }).ready = Promise.resolve(true);
    let lineSeq = 100;
    answer = (message) => {
      if (message.method !== "turn/start") return;
      queueMicrotask(() =>
        c.receive({
          seq: ++lineSeq,
          dir: "out",
          message: { id: message.id, result: { turn: { id: "turn-9" } } },
        } as never),
      );
    };
    await c.send("Run the tests.", [], FROM);
    await Bun.sleep(20);
    const start = written.find((m) => m.method === "turn/start") as {
      params: { clientUserMessageId: string; input: { text: string }[] };
    };
    expect(start.params.input[0]?.text).toBe(`${HEADER}\n\nRun the tests.`);
    const id = start.params.clientUserMessageId;
    expect(records).toEqual([
      { id, from: FROM, at: expect.any(Number) },
      { id, from: FROM, at: expect.any(Number), turnId: "turn-9" },
    ]);
  });
});

describe("the senders a tab keeps", () => {
  test("one an id, kept as the conversation goes on in another session or profile", () => {
    const tabs = () => useTabsStore.getState();
    const tab = tabs().createTab("ws-relay-store", {
      type: "claude",
      props: { cwd: "/p", sessionId: "old" },
    });
    tabs().addChatRelayed("ws-relay-store", tab.id, { id: "u1", from: FROM, at: 1 });
    tabs().addChatRelayed("ws-relay-store", tab.id, { id: "u1", from: FROM, at: 1, turnId: "t" });
    tabs().setClaudeTarget("ws-relay-store", tab.id, { fork: { sessionId: "old" } });
    tabs().setChatProfile("ws-relay-store", tab.id, "work");
    tabs().setClaudeSession("ws-relay-store", tab.id, "copy");
    const props = tabs().byWorkspace["ws-relay-store"]?.[tab.id]?.props as {
      relayed?: RelayedMessage[];
    };
    expect(props.relayed).toEqual([{ id: "u1", from: FROM, at: 1, turnId: "t" }]);
  });
});
