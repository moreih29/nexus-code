/**
 * The messages a tab holds for after its turn (⌘⇧↩, or chat.send `after`
 * from another device): each held has its id, its text can change with its
 * images kept, and an agent's keeps who sent it. The real ipc client is
 * spread under a spy.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";

(globalThis as { __APP_VERSION__?: string }).__APP_VERSION__ ??= "0.0.0";

const realIpc = await import("../../../../../src/renderer/ipc/client");
mock.module("../../../../../src/renderer/ipc/client", () => ({
  ...realIpc,
  ipcListen: () => () => {},
  ipcCallResult: () => Promise.resolve({ ok: true, value: undefined }),
}));

const { ChatController } = await import("../../../../../src/renderer/services/chat/controller");
const { CodexController } = await import(
  "../../../../../src/renderer/services/chat/codex-controller"
);
const { useChatStore } = await import("../../../../../src/renderer/services/chat/store");

const FROM = { kind: "tab", agent: "codex", name: "Plan", workspaceId: "ws", tabId: "t0" } as const;
const IMAGE = { mediaType: "image/png", data: "AA" };

let seq = 0;
const live: { dispose: () => void }[] = [];
afterEach(() => {
  for (const c of live.splice(0)) c.dispose();
});

function running(key: string): void {
  useChatStore.getState().update(key, (prev) => ({
    ...prev,
    phase: "ready",
    model: { ...prev.model, process: "running", running: true } as typeof prev.model,
  }));
}

describe("a Claude tab's held messages", () => {
  test("each held has its id, keeps who sent it, and its text changes with its images kept", () => {
    const c = new ChatController(
      { workspaceId: "ws-queue", tabId: `t${++seq}`, cwd: "/p", sessionId: "s" },
      {},
    );
    live.push(c);
    running(c.key);
    const first = c.enqueue("first", [IMAGE], FROM);
    const second = c.enqueue("second");
    expect(first).toBeString();
    expect(second).not.toBe(first);
    expect(c.state.queue).toEqual([
      { id: first as string, text: "first", images: [IMAGE], from: FROM },
      { id: second as string, text: "second", images: [] },
    ]);
    expect(c.editQueued(first as string, "changed")).toBe(true);
    expect(c.state.queue[0]).toMatchObject({ text: "changed", images: [IMAGE], from: FROM });
    expect(c.removeQueued(second as string)?.text).toBe("second");
    expect(c.editQueued(second as string, "gone")).toBe(false);
  });
});

describe("a Codex tab's held messages", () => {
  test("each held has its id; its text changes once, not after it went", () => {
    const c = new CodexController(
      { workspaceId: "ws-queue", tabId: `x${++seq}`, cwd: "/p", threadId: "th" },
      {},
    );
    live.push(c);
    running(c.key);
    const id = c.enqueue("later", [], FROM);
    expect(id).toBeString();
    expect(c.editQueued(id as string, "sooner")).toBe(true);
    expect(c.state.queue).toEqual([{ id: id as string, text: "sooner", images: [], from: FROM }]);
    c.removeQueued(id as string);
    expect(c.editQueued(id as string, "again")).toBe(false);
  });
});
