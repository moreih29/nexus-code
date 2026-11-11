/**
 * A Codex tab is called by its conversation's first message: a message sent
 * to a thread resumed after the app restarted, which shows the messages it
 * had, leaves the tab's name as it was. The real ipc client is spread under
 * a spy.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";

(globalThis as { __APP_VERSION__?: string }).__APP_VERSION__ ??= "0.0.0";

const realIpc = await import("../../../../../src/renderer/ipc/client");
mock.module("../../../../../src/renderer/ipc/client", () => ({
  ...realIpc,
  ipcListen: () => () => {},
  ipcCallResult: () => Promise.resolve({ ok: true, value: undefined }),
}));

const { CodexController } = await import(
  "../../../../../src/renderer/services/chat/codex-controller"
);
const { useChatStore } = await import("../../../../../src/renderer/services/chat/store");

let seq = 0;
const live: { dispose: () => void }[] = [];

afterEach(() => {
  for (const c of live.splice(0)) c.dispose();
});

/** A Codex tab running its thread, showing `items`, and the titles it was given. */
function tab(items: unknown[]) {
  const titles: string[] = [];
  const c = new CodexController(
    { workspaceId: "ws-title", tabId: `t${++seq}`, cwd: "/p", threadId: "th" },
    { onFirstMessage: (text) => titles.push(text) },
  );
  live.push(c);
  useChatStore.getState().update(c.key, (prev) => ({
    ...prev,
    phase: "ready",
    model: { ...prev.model, process: "running", threadId: "th", items } as typeof prev.model,
  }));
  (c as unknown as { ready: Promise<boolean> }).ready = Promise.resolve(true);
  return { c, titles };
}

describe("a Codex tab's name", () => {
  test("is its conversation's first message", async () => {
    const { c, titles } = tab([]);
    await c.send("Plan the refactor.");
    await c.send("Then run the tests.");
    expect(titles).toEqual(["Plan the refactor."]);
  });

  test("stays as it was for a message to a thread resumed after a restart", async () => {
    const { c, titles } = tab([
      { kind: "user", key: "u1.0.0", text: "Plan the refactor.", images: [], state: "taken" },
      { kind: "assistant", key: "a1.0.1", text: "Done." },
    ]);
    await c.send("What did you plan?");
    expect(titles).toEqual([]);
  });
});
