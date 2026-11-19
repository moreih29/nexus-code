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

const { ChatController } = await import(
  "../../../../../src/renderer/services/chat/claude/controller"
);
const { CodexController } = await import(
  "../../../../../src/renderer/services/chat/codex/controller"
);
const { clearObservedQueued, dispatchQueuedMessage, emptyTabState, useChatStore } = await import(
  "../../../../../src/renderer/services/chat/store"
);

import type { ChatTabState } from "../../../../../src/renderer/services/chat/store";

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

  test("one held from another computer says which; changed from there, it is that user's, not the agent's", () => {
    const c = new ChatController(
      { workspaceId: "ws-queue", tabId: `t${++seq}`, cwd: "/p", sessionId: "s" },
      {},
    );
    live.push(c);
    running(c.key);
    const mine = c.enqueue("from the phone", [], undefined, "phone");
    const agents = c.enqueue("from an agent", [], { ...FROM, device: { id: "mac", name: "Mac" } });
    expect(c.state.queue[0]).toMatchObject({ text: "from the phone", device: "phone" });
    expect(c.editQueued(agents as string, "rewritten", "phone")).toBe(true);
    expect(c.state.queue[1]).toEqual({
      id: agents as string,
      text: "rewritten",
      images: [],
      device: "phone",
    });
    expect(mine).toBeString();
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

test("an unconfirmed queue entry keeps its payload until independently observed", async () => {
  let state: ChatTabState = {
    ...emptyTabState(),
    queue: [{ id: "uncertain", text: "image pending", images: [IMAGE] }],
  };
  const update = (change: (value: ChatTabState) => ChatTabState) => {
    state = change(state);
  };
  const send = mock(async () => {
    throw new Error("connection closed");
  });
  const done = mock(() => {});
  const drain = () =>
    dispatchQueuedMessage(
      state.queue,
      update,
      send,
      () => false,
      () => false,
      done,
    );
  drain();
  drain();
  expect(state.queue[0]?.status).toBe("sending");
  await Promise.resolve();
  drain();
  expect(send).toHaveBeenCalledTimes(1);
  expect(done).not.toHaveBeenCalled();
  expect(state.queue).toEqual([
    {
      id: "uncertain",
      text: "image pending",
      images: [IMAGE],
      status: "unconfirmed",
      error: "connection closed",
    },
  ]);
  expect(clearObservedQueued(state, (id) => id === "different")).toBe(state);
  expect(clearObservedQueued(state, (id) => id === "uncertain").queue).toEqual([]);
});

test("a confirmed queue send releases the held attachment payload", async () => {
  let state: ChatTabState = {
    ...emptyTabState(),
    queue: [{ id: "ok", text: "accepted", images: [IMAGE] }],
  };
  dispatchQueuedMessage(
    state.queue,
    (change) => {
      state = change(state);
    },
    async () => {},
    () => false,
    () => false,
    () => {},
  );
  expect(state.queue[0]?.status).toBe("sending");
  await Promise.resolve();
  expect(state.queue).toEqual([]);
});
