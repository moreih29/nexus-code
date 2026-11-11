/**
 * A message sent to a tab counts the tab as working until the conversation
 * shows it. A tab that was not open since the app restarted brings its
 * conversation back only as its program starts: those messages are not the
 * one sent, and `chat send --wait` must not take the last of their answers
 * for the reply. The real ipc client is spread under a spy.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";

(globalThis as { __APP_VERSION__?: string }).__APP_VERSION__ ??= "0.0.0";

const realIpc = await import("../../../../../src/renderer/ipc/client");
mock.module("../../../../../src/renderer/ipc/client", () => ({
  ...realIpc,
  ipcListen: () => () => {},
  ipcCallResult: () => Promise.resolve({ ok: true, value: undefined }),
}));

const { sendToAgentTab, sendUnseen } = await import(
  "../../../../../src/renderer/services/chat/agent-tab"
);
const { chatKey, useChatStore } = await import("../../../../../src/renderer/services/chat/store");

type Target = Parameters<typeof sendToAgentTab>[2];

const WS = "ws-send";
let seq = 0;
const keys: string[] = [];

afterEach(() => {
  useChatStore.setState((state) => {
    const tabs = { ...state.tabs };
    for (const key of keys.splice(0)) delete tabs[key];
    return { tabs };
  });
});

/** Shows `count` messages of the user's in the tab. */
function showUserMessages(key: string, count: number): void {
  useChatStore.getState().update(key, (prev) => ({
    ...prev,
    model: {
      ...prev.model,
      items: Array.from({ length: count }, (_, i) => ({
        kind: "user",
        key: `u${i}`,
        text: `message ${i}`,
        images: [],
        state: "taken",
      })),
    } as typeof prev.model,
  }));
}

/**
 * A tab whose program, as it starts (to send, or before), brings back
 * `resumed` messages of a conversation it had; sending writes the message
 * but shows nothing yet.
 */
function tab(resumed: number, fail?: Error) {
  const tabId = `t${++seq}`;
  const key = chatKey(WS, tabId);
  keys.push(key);
  const sent: string[] = [];
  let running = false;
  const start = () => {
    if (fail) throw fail;
    if (running) return;
    running = true;
    showUserMessages(key, resumed);
  };
  const controller = {
    prepareSend: async () => start(),
    send: async (text: string) => {
      start();
      sent.push(text);
    },
  };
  const target = { agent: "codex", controller } as unknown as Target;
  return { tabId, key, target, sent };
}

describe("sendToAgentTab", () => {
  test("a resumed conversation's messages do not pass for the one sent", async () => {
    const t = tab(3);
    await sendToAgentTab(WS, t.tabId, t.target, "What changed?");
    expect(t.sent).toEqual(["What changed?"]);
    expect(sendUnseen(WS, t.tabId)).toBe(true);

    showUserMessages(t.key, 4);
    expect(sendUnseen(WS, t.tabId)).toBe(false);
  });

  test("the tab counts as working while its program starts", async () => {
    const t = tab(2);
    let release: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      release = resolve;
    });
    const prepare = (t.target.controller as unknown as { prepareSend: () => Promise<void> })
      .prepareSend;
    (t.target.controller as unknown as { prepareSend: () => Promise<void> }).prepareSend =
      async () => {
        await started;
        await prepare();
      };
    const sending = sendToAgentTab(WS, t.tabId, t.target, "hello");
    expect(sendUnseen(WS, t.tabId)).toBe(true);
    release();
    await sending;
    expect(sendUnseen(WS, t.tabId)).toBe(true);
  });

  test("a tab whose program cannot run says so, and does not stay working", async () => {
    const t = tab(0, new Error("Codex is not running"));
    await expect(sendToAgentTab(WS, t.tabId, t.target, "hello")).rejects.toThrow(
      "Codex is not running",
    );
    expect(t.sent).toEqual([]);
    expect(sendUnseen(WS, t.tabId)).toBe(false);
  });
});
