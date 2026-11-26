import { afterEach, describe, expect, mock, test } from "bun:test";
import { ipcErr } from "../../../../../src/shared/ipc/result";

(globalThis as { __APP_VERSION__?: string }).__APP_VERSION__ ??= "0.0.0";

const realIpc = await import("../../../../../src/renderer/ipc/client");
let userWrite: Record<string, unknown> | undefined;
let writeError: "agent.reconnect-unavailable" | "chat.stdin-write-failed" | undefined;
mock.module("../../../../../src/renderer/ipc/client", () => ({
  ...realIpc,
  ipcListen: () => () => {},
  ipcCallResult: (
    _channel: string,
    method: string,
    args?: { message?: Record<string, unknown> },
  ) => {
    if (method === "send" && args?.message?.type === "user") {
      userWrite = args.message;
      if (writeError) return Promise.resolve(ipcErr(writeError, "write did not confirm"));
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
const { clearObservedQueued, dispatchQueuedMessage } = await import(
  "../../../../../src/renderer/services/chat/transport/queue"
);
const { emptyTabState, useChatStore } = await import(
  "../../../../../src/renderer/services/chat/store"
);

const { chatSubmissionInfo } = await import("../../../../../src/renderer/services/cli/chat-view");

import type { ChatTabState } from "../../../../../src/renderer/services/chat/store";

const FROM = { kind: "tab", agent: "codex", name: "Plan", workspaceId: "ws", tabId: "t0" } as const;
const IMAGE = { mediaType: "image/png", data: "AA" };

let seq = 0;
const live: { dispose: () => void }[] = [];
afterEach(() => {
  for (const c of live.splice(0)) c.dispose();
  writeError = undefined;
  userWrite = undefined;
});

function running(key: string): void {
  useChatStore.getState().update(key, (prev) => ({
    ...prev,
    phase: "ready",
    model: { ...prev.model, process: "running", running: true } as typeof prev.model,
  }));
}

describe("a Claude tab's held messages", () => {
  test("settles an unconfirmed composer send when its stdin write appears in the log", async () => {
    const c = new ChatController({ workspaceId: "ws-queue", tabId: "claude-composer", cwd: "/p" });
    live.push(c);
    running(c.key);
    writeError = "agent.reconnect-unavailable";
    await c.submitLocal("could already be queued", [IMAGE], false);
    expect(c.state.queue).toMatchObject([
      {
        id: userWrite?.uuid,
        text: "could already be queued",
        images: [IMAGE],
        status: "unconfirmed",
      },
    ]);
    c.receive({ seq: ++seq, dir: "in", message: userWrite ?? {} });
    c.flushNow();
    expect(c.state.queue).toEqual([]);
    expect(c.state.model.items).toContainEqual(
      expect.objectContaining({ kind: "user", text: "could already be queued", queued: true }),
    );

    writeError = "chat.stdin-write-failed";
    await expect(c.submitLocal("definite failure", [], false)).rejects.toMatchObject({
      kind: "chat.stdin-write-failed",
    });
    expect(c.state.queue).toEqual([]);
  });

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

test.each([
  "claude",
  "codex",
] as const)("%s cancellation ends the held submission's wait", (agent) => {
  const target = { workspaceId: "ws-queue", tabId: `cancel-${agent}`, cwd: "/p" };
  const controller = agent === "claude" ? new ChatController(target) : new CodexController(target);
  live.push(controller);
  running(controller.key);
  controller.enqueue("Review this", [], undefined, undefined, "receipt");
  expect(chatSubmissionInfo(agent, controller.state, "receipt").state).toBe("working");

  expect(controller.removeQueued("receipt")?.text).toBe("Review this");
  expect(chatSubmissionInfo(agent, controller.state, "receipt")).toEqual({
    agent,
    state: "error",
    message: "the held message was cancelled",
  });
  expect(chatSubmissionInfo(agent, controller.state, "still-pending").state).toBe("working");
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
