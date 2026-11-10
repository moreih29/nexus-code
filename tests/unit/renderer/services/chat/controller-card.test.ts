/**
 * A command's card (/status, /goal…) tells of the conversation the tab had
 * when it ran: it closes as the tab goes on with another, from /new,
 * /resume or /clear. The real ipc client is spread under a spy, so later
 * files keep its other exports.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";

const realIpc = await import("../../../../../src/renderer/ipc/client");
mock.module("../../../../../src/renderer/ipc/client", () => ({
  ...realIpc,
  // A Codex tab listens for its lines as it is made; none come here.
  ipcListen: () => () => {},
  ipcCallResult: (_channel: string, method: string) => {
    // A start that does not come up: nothing past it runs here.
    if (method === "start" || method === "codexStart") {
      return Promise.resolve({
        ok: true,
        value: { ok: false, reason: "failed", message: "not here" },
      });
    }
    if (method === "transcript") return Promise.resolve({ ok: true, value: { found: false } });
    return Promise.resolve({ ok: true, value: undefined });
  },
}));

const { ChatController } = await import("../../../../../src/renderer/services/chat/controller");
const { CodexController } = await import(
  "../../../../../src/renderer/services/chat/codex-controller"
);

let seq = 0;
const live: { dispose: () => void }[] = [];

afterEach(() => {
  for (const c of live.splice(0)) c.dispose();
});

describe("a Codex tab's card", () => {
  function codex() {
    const c = new CodexController(
      { workspaceId: "ws-card", tabId: `x${++seq}`, cwd: "/p", threadId: "old" },
      {},
    );
    live.push(c);
    c.showCard({ title: "/status", text: "thread old" });
    return c;
  }

  test("closes with /new", async () => {
    const c = codex();
    expect(c.state.card?.title).toBe("/status");
    await c.newThread();
    expect(c.state.card).toBeUndefined();
  });

  test("closes as another thread goes on in the tab", async () => {
    const c = codex();
    await c.resumeThread("other", "Other");
    expect(c.state.card).toBeUndefined();
  });
});

describe("a Claude tab's card", () => {
  function claude() {
    const c = new ChatController(
      { workspaceId: "ws-card", tabId: `t${++seq}`, cwd: "/p", sessionId: "old" },
      {},
    );
    live.push(c);
    c.showCard({ title: "/status", text: "session old" });
    return c;
  }

  test("closes as another session goes on in the tab", async () => {
    const c = claude();
    expect(c.state.card?.title).toBe("/status");
    await c.resumeSession("other");
    expect(c.state.card).toBeUndefined();
  });

  test("closes with /clear", () => {
    const c = claude();
    const lastSeq = c.state.model.lastSeq;
    const lines = [
      {
        seq: lastSeq + 1,
        dir: "out",
        message: { type: "conversation_reset", session_id: "old" },
      },
    ];
    (c as unknown as { buffered: unknown[] }).buffered.push(...lines);
    c.flushNow();
    expect(c.state.model.clears).toBe(1);
    expect(c.state.card).toBeUndefined();
  });

  test("stays while the session goes on", () => {
    const c = claude();
    const lastSeq = c.state.model.lastSeq;
    (c as unknown as { buffered: unknown[] }).buffered.push({
      seq: lastSeq + 1,
      dir: "out",
      message: { type: "result", subtype: "success" },
    });
    c.flushNow();
    expect(c.state.card?.title).toBe("/status");
  });
});
