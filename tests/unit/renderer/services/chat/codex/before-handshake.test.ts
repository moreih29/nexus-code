/**
 * A Codex program takes no request before it knows the app (initialize):
 * one sent before is refused with "Not initialized", which a tab showed as
 * an error. What a tab asks as it opens (its list of threads, its
 * defaults) waits for the introduction. The real ipc client is spread
 * under a spy, so later files keep its other exports.
 */
import { afterEach, describe, expect, jest, mock, spyOn, test } from "bun:test";
import { defaultProfileId } from "../../../../../../src/shared/agent-profiles/profiles";
import { ipcContract } from "../../../../../../src/shared/ipc/contract";
import type { WorkspaceMeta } from "../../../../../../src/shared/types/workspace";

// The version the app tells Codex it is.
(globalThis as { __APP_VERSION__?: string }).__APP_VERSION__ ??= "0.0.0";

type Message = Record<string, unknown>;
/** A Codex program that comes up, answering what is sent to it as the test says. */
let codex: ((message: Message) => void) | undefined;
const catalogWorkspace = "b99ee5a4-4db7-43c4-8c3f-31262141cdaa";
const catalogCalls: { method: string; args: Message }[] = [];
const contract = ipcContract.chat.call;

const realIpc = await import("../../../../../../src/renderer/ipc/client");
mock.module("../../../../../../src/renderer/ipc/client", () => ({
  ...realIpc,
  ipcListen: () => () => {},
  ipcCallResult: (_channel: string, method: string, args: Record<string, unknown>) => {
    const catalog = args.workspaceId === catalogWorkspace;
    if (catalog) {
      switch (method) {
        case "codexStart":
        case "send":
        case "close":
          contract[method].args.parse(args);
          catalogCalls.push({ method, args });
          break;
      }
    }
    if (method === "send") codex?.(args.message as Message);
    if (method === "stop") onStop?.();
    if (method === "replay") {
      return Promise.resolve(replayResponse?.()).then((value) => ({ ok: true, value }));
    }
    if (method === "codexStart") {
      starts.push(args);
      onStart?.();
      const value = startFailure
        ? { ok: false, reason: "failed", message: startFailure }
        : { ok: true, pid: 1, attached: false, version: installedVersion, ...hostFolder };
      return Promise.resolve({
        ok: true,
        value: catalog ? contract.codexStart.result.parse(value) : value,
      });
    }
    return Promise.resolve({ ok: true, value: undefined });
  },
}));

const { CodexController } = await import(
  "../../../../../../src/renderer/services/chat/codex/controller"
);
const { invalidateCodexHistory } = await import(
  "../../../../../../src/renderer/services/chat/codex/history-catalog"
);
const { pastSessionsOf, peerCodexThreads } = await import(
  "../../../../../../src/renderer/services/remote/history"
);
const { useChatStore } = await import("../../../../../../src/renderer/services/chat/store");
type Controller = InstanceType<typeof CodexController>;

let seq = 0;
let lineSeq = 5000;
const live: Controller[] = [];
const sent: Message[] = [];
const starts: Message[] = [];
let hostFolder: { canonicalCwd?: string } = {};
let installedVersion: string | null = null;
let replayResponse: (() => unknown) | undefined;
let onStart: (() => void) | undefined;
let onStop: (() => void) | undefined;
let startFailure: string | undefined;

afterEach(() => {
  for (const c of live.splice(0)) c.dispose();
  jest.useRealTimers();
  codex = undefined;
  sent.length = 0;
  starts.length = 0;
  catalogCalls.length = 0;
  invalidateCodexHistory(catalogWorkspace);
  hostFolder = {};
  installedVersion = null;
  replayResponse = undefined;
  onStart = undefined;
  onStop = undefined;
  startFailure = undefined;
});

/** A tab whose program is not running and answers initialize a while after it is asked. */
function tab(respond?: (message: Message) => unknown | Promise<unknown>): Controller {
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
      respond?.(message) ??
      (message.method === "initialize"
        ? { userAgent: "nexus-code/0.170.0 (test)" }
        : message.method === "thread/resume"
          ? { thread: { id: (message.params as Message).threadId } }
          : message.method === "thread/list"
            ? { data: [] }
            : message.method === "config/read"
              ? { config: {} }
              : {});
    const answer = async () => {
      const value = await result;
      c.receive({ seq: ++lineSeq, dir: "in", message } as never);
      c.receive({
        seq: ++lineSeq,
        dir: "out",
        message: { id: message.id, result: value },
      } as never);
    };
    if (message.method === "initialize") setTimeout(answer, 30);
    else queueMicrotask(answer);
  };
  useChatStore.getState().update(c.key, (prev) => ({ ...prev, phase: "ended" }));
  return c;
}

const order = () => sent.map((m) => m.method);

/** Streams a scripted app-server's lines with no real startup delay. */
function scriptProgram(c: Controller, reply: (message: Message) => Message): void {
  const line = (dir: "sys" | "in" | "out", message: Message) =>
    c.receive({ seq: ++lineSeq, dir, message } as never);
  onStart = () => line("sys", { event: "start" });
  onStop = () => line("sys", { event: "exit", code: 0 });
  codex = (message) => {
    sent.push(message);
    line("in", message);
    if (message.id !== undefined) line("out", { id: message.id, ...reply(message) });
  };
}

test("closing a Codex tab during replay cannot open a new program once replay ends", async () => {
  const c = tab();
  const replay = Promise.withResolvers<unknown>();
  replayResponse = () => replay.promise;
  const opening = c.open();
  await c.close();
  replay.resolve({ found: false, running: false, truncated: false, lastSeq: 0 });
  await opening;
  expect(starts).toEqual([]);
});

test("a rejected Codex initialize leaves a failed tab and lets retry spawn another program", async () => {
  const c = tab();
  onStart = () => c.receive({ seq: ++lineSeq, dir: "sys", message: { event: "start" } } as never);
  let stops = 0;
  onStop = () => {
    stops += 1;
    c.receive({ seq: ++lineSeq, dir: "sys", message: { event: "exit", code: 0 } } as never);
  };
  let rejectInitialize = true;
  codex = (message) => {
    sent.push(message);
    if (message.id === undefined) return;
    c.receive({ seq: ++lineSeq, dir: "in", message } as never);
    const reply =
      rejectInitialize && message.method === "initialize"
        ? { error: { code: -32600, message: "initialize refused" } }
        : { result: message.method === "thread/resume" ? { thread: { id: "t1" } } : {} };
    c.receive({ seq: ++lineSeq, dir: "out", message: { id: message.id, ...reply } } as never);
  };
  await expect(c.prepareSend()).rejects.toThrow();
  expect(c.state).toMatchObject({ phase: "failed", error: "initialize refused" });
  expect(stops).toBe(1);
  expect(order()).not.toContain("thread/resume");

  rejectInitialize = false;
  await c.prepareSend();
  expect(c.state.phase).toBe("ready");
  expect(starts).toHaveLength(2);
  expect(c.currentThread()).toBe("t1");
});

test("Codex stays unready until resume returns the requested thread", async () => {
  const c = tab();
  const resuming = Promise.withResolvers<void>();
  const reply = Promise.withResolvers<Message>();
  codex = (message) => {
    if (message.id === undefined) return;
    c.receive({ seq: ++lineSeq, dir: "in", message } as never);
    if (message.method === "thread/resume") resuming.resolve();
    const result = message.method === "thread/resume" ? reply.promise : {};
    void Promise.resolve(result).then((value) => {
      c.receive({
        seq: ++lineSeq,
        dir: "out",
        message: { id: message.id, result: value },
      } as never);
    });
  };
  const prepared = c.prepareSend().then(
    () => undefined,
    (error: unknown) => error,
  );
  await resuming.promise;
  const phase = c.state.phase;
  reply.resolve({});
  expect(await prepared).toBeInstanceOf(Error);
  expect(phase).toBe("starting");
  expect(c.state.error).toBe("Codex did not return the requested thread");
});

test("a failed restored Codex resume keeps the thread and waits for an explicit retry", async () => {
  const c = tab();
  let canResume = false;
  scriptProgram(c, (message) => {
    if (message.method === "thread/resume") {
      return canResume
        ? { result: { thread: { id: "t1" } } }
        : { error: { code: -32600, message: "no rollout found for thread id t1" } };
    }
    if (message.method === "thread/start") return { result: { thread: { id: "wrong" } } };
    if (message.method === "turn/start") return { result: { turn: { id: "sent" } } };
    return { result: {} };
  });
  await expect(c.send("preserve this prompt")).rejects.toThrow();
  expect(c.currentThread()).toBe("t1");
  expect(c.state.phase).toBe("failed");
  expect(order()).not.toContain("thread/start");
  expect(order()).not.toContain("turn/start");

  canResume = true;
  await c.send("preserve this prompt");
  expect(sent.find((message) => message.method === "turn/start")?.params).toMatchObject({
    threadId: "t1",
    input: [{ type: "text", text: "preserve this prompt" }],
  });
});

test("a known empty Codex thread can be replaced when it has no rollout", async () => {
  const c = new CodexController({ workspaceId: "ws-codex-handshake", tabId: "empty", cwd: "/p" });
  live.push(c);
  let count = 0;
  scriptProgram(c, (message) => {
    if (message.method === "thread/start")
      return { result: { thread: { id: `empty-${++count}` } } };
    if (message.method === "thread/resume")
      return { error: { code: -32600, message: "no rollout found for thread id empty-1" } };
    return { result: {} };
  });
  await c.prepareSend();
  expect(c.currentThread()).toBe("empty-1");
  await c.restart();
  expect(c.state.phase).toBe("ready");
  expect(c.currentThread()).toBe("empty-2");
});

test("a refused profile resume does not persist the destination thread or title", async () => {
  const c = tab();
  const persisted: string[] = [];
  c.setHooks({
    onProfile: (id) => persisted.push(id),
    onThread: (id) => persisted.push(id),
    onTitle: (title) => persisted.push(title),
  });
  scriptProgram(c, (message) =>
    message.method === "thread/resume"
      ? { error: { code: -32600, message: "resume refused" } }
      : { result: {} },
  );
  await expect(c.resumeThread("dest", "Destination", "work")).rejects.toThrow("resume refused");
  expect(c.currentThread()).toBe("t1");
  expect(c.profileId).toBe("codex-default");
  expect(persisted).toEqual([]);
});

test("CLI resume cannot replace a conversation or switch profiles in an existing tab", async () => {
  const c = tab();
  await expect(c.resumeThread("dest", "Destination", "work", true)).rejects.toThrow(
    "conversation's profile",
  );
  await expect(c.resumeThread("dest", "Destination", c.profileId, true)).rejects.toThrow(
    "empty tab",
  );
  expect(c.currentThread()).toBe("t1");
  expect(c.profileId).toBe("codex-default");
  expect(starts).toEqual([]);
});

test("resumes a Codex thread after agent replacement and queues against the new log", async () => {
  jest.useFakeTimers();
  const c = tab();
  let seq = 400;
  const line = (dir: "sys" | "in" | "out", message: Message, replay = false) =>
    c.receive({ seq: ++seq, dir, message, replay } as never);
  const turn = (id: string) =>
    line("out", { method: "turn/started", params: { threadId: "t1", turn: { id } } });
  const approve = (turnId: string) =>
    line("out", {
      id: 1,
      method: "item/commandExecution/requestApproval",
      params: { turnId, command: "pwd" },
    });
  codex = () => {};
  replayResponse = () => {
    line("sys", { event: "start" }, true);
    line("in", { id: "resume", method: "thread/resume" }, true);
    line("out", { id: "resume", result: { thread: { id: "t1" } } }, true);
    line(
      "in",
      { method: "turn/start", params: { input: [{ type: "text", text: "old prompt" }] } },
      true,
    );
    line("sys", { event: "dropped" }, true);
    return { found: true, running: true, truncated: false, lastSeq: seq };
  };
  await c.open();
  turn("old");
  approve("old");
  await c.sendWithTiming("queued prompt", [], "next", undefined, undefined, "queued");
  const oldPermission = c.model.permissions[0];
  expect(oldPermission?.requestId).toBe("1");
  expect(c.state.queue[0]?.afterTool).toBe(seq);

  c.held();
  replayResponse = () => ({ found: false, running: false, truncated: false, lastSeq: 0 });
  await c.resync();
  expect(c.model.lastSeq).toBe(0);
  expect(c.model.permissions).toEqual([]);
  expect(c.model.requests).toEqual({});
  await c.answerPermission(oldPermission, { kind: "allow" });
  expect(c.state.queue[0]?.afterTool).toBe(0);

  seq = 0;
  const steered = Promise.withResolvers<Message>();
  onStart = () => line("sys", { event: "start" });
  codex = (message) => {
    sent.push(message);
    line("in", message);
    if (message.id === undefined) return;
    const result = message.method === "thread/resume" ? { thread: { id: "t1" } } : {};
    line("out", { id: message.id, result });
    if (message.method === "turn/steer") steered.resolve(message);
  };
  await c.prepareSend();
  expect(sent.find((m) => m.method === "thread/resume")?.params).toMatchObject({
    threadId: "t1",
    excludeTurns: true,
  });
  expect(c.model.process).toBe("running");
  expect(c.model.items.filter((item) => item.kind === "user").map((item) => item.text)).toEqual([
    "old prompt",
  ]);
  expect(new Set(c.model.items.map((item) => item.key)).size).toBe(c.model.items.length);

  turn("new");
  approve("new");
  c.flushNow();
  expect(c.model.requests["1"]?.params.turnId).toBe("new");
  const writes = sent.length;
  await c.answerPermission(oldPermission, { kind: "allow" });
  expect(sent).toHaveLength(writes);
  await c.answerPermission(c.model.permissions[0], { kind: "allow" });
  expect(order()).not.toContain("turn/steer");
  line("out", {
    method: "item/completed",
    params: {
      threadId: "t1",
      turnId: "new",
      item: { id: "cmd", type: "commandExecution", command: "pwd", status: "completed" },
    },
  });
  c.flushNow();
  expect(c.model.toolCompletedSeq).toBe(seq);
  expect((await steered.promise).params).toMatchObject({
    threadId: "t1",
    expectedTurnId: "new",
    input: [{ type: "text", text: "queued prompt" }],
  });
  seq = 404;
  line("sys", { event: "dropped" });
  c.flushNow();
  expect(new Set(c.model.items.map((item) => item.key)).size).toBe(c.model.items.length);
});

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

test("resume starts the selected Codex profile and waits for its thread", async () => {
  const c = tab();
  await c.resumeThread("other", "Other", "another-profile");
  expect(starts.at(-1)).toMatchObject({ profileId: "another-profile", resetLog: true });
  expect(c.model.threadId).toBe("other");
  expect(c.profileId).toBe("another-profile");
});

test("history boundaries use the installed version when initialize omits its user agent", async () => {
  installedVersion = "0.170.0";
  const c = tab();
  const prompt = { id: "prompt", type: "userMessage", content: [{ type: "text", text: "hello" }] };
  const answer = { id: "answer", type: "agentMessage", text: "hi" };
  scriptProgram(c, (message) => ({
    result:
      message.method === "thread/resume"
        ? {
            thread: {
              id: "t1",
              cliVersion: "0.166.0",
              turns: [{ id: "history", status: "completed", items: [prompt, answer] }],
            },
          }
        : {},
  }));
  await c.prepareSend();
  expect(c.model.appServerVersion).toBeUndefined();

  c.receive({
    seq: ++lineSeq,
    dir: "out",
    message: { method: "turn/started", params: { threadId: "t1", turn: { id: "live" } } },
  });
  for (const item of [
    { ...prompt, id: "live-prompt" },
    { ...answer, id: "live-answer" },
  ]) {
    c.receive({
      seq: ++lineSeq,
      dir: "out",
      message: { method: "item/completed", params: { threadId: "t1", turnId: "live", item } },
    });
  }
  c.receive({
    seq: ++lineSeq,
    dir: "out",
    message: {
      method: "turn/completed",
      params: { threadId: "t1", turn: { id: "live", status: "completed" } },
    },
  });
  c.flushNow();

  expect(c.model.items).toMatchObject([
    { kind: "user", forkable: true, rewindable: true },
    { kind: "assistant", forkable: true },
    { kind: "user", forkable: true, rewindable: true },
    { kind: "assistant", forkable: true },
  ]);
});

test("rewind excludes a concurrent send and keeps the parent when the prefix is wrong", async () => {
  const first = { id: "turn1", status: "completed", items: [] };
  const cut = {
    id: "turn2",
    status: "completed",
    items: [{ id: "prompt", type: "userMessage", content: [{ type: "text", text: "again" }] }],
  };
  let release!: () => void;
  const pendingRead = new Promise<void>((resolve) => {
    release = resolve;
  });
  let didRead!: () => void;
  const reading = new Promise<void>((resolve) => {
    didRead = resolve;
  });
  const source = { thread: { id: "t1", turns: [first, cut] } };
  const c = tab((message) => {
    switch (message.method) {
      case "thread/resume":
        return source;
      case "thread/read":
        return { thread: { id: "t1", status: { type: "idle" } } };
      case "thread/turns/list": {
        if ((message.params as Message).cursor === "second") {
          didRead();
          return pendingRead.then(() => ({ data: [{ id: cut.id }], nextCursor: "unused" }));
        }
        return { data: [{ id: first.id }], nextCursor: "second" };
      }
      case "thread/fork":
        return { thread: { id: "improper", forkedFromId: "t1", turns: [] } };
    }
  });
  await c.prepareSend();
  const item = c.model.items.find((item) => item.kind === "user");
  if (!item || item.kind !== "user") throw new Error("missing test user message");
  await expect(c.rewind(item, { files: true })).rejects.toThrow("cannot restore files");
  const rewind = c.rewind(item, { files: false });
  await reading;
  await expect(c.send("concurrent")).rejects.toThrow("changing the conversation");
  release();
  await expect(rewind).rejects.toThrow("unexpected fork history");
  expect(c.currentThread()).toBe("t1");
  expect(sent.find((m) => m.method === "thread/read")?.params).toEqual({
    threadId: "t1",
    includeTurns: false,
  });
  expect(sent.filter((m) => m.method === "thread/turns/list").map((m) => m.params)).toEqual([
    { threadId: "t1", sortDirection: "asc", itemsView: "notLoaded", limit: 100 },
    { threadId: "t1", sortDirection: "asc", itemsView: "notLoaded", limit: 100, cursor: "second" },
  ]);
  expect(order()).not.toContain("turn/start");
  expect(sent.find((m) => m.method === "thread/delete")?.params).toEqual({ threadId: "improper" });
});

test("lists exactly the requested folder and its canonical path from the workspace host", async () => {
  hostFolder = { canonicalCwd: "/host/physical/project" };
  const c = tab((message) => {
    if (message.method !== "thread/list") return;
    const { cwd } = message.params as { cwd: string };
    return {
      data:
        cwd === "/host/physical/project"
          ? [{ id: "found", preview: "a saved thread", updatedAt: 1 }]
          : [],
    };
  });
  expect(await c.listThreads()).toMatchObject([{ sessionId: "found" }]);
  expect(sent.filter((m) => m.method === "thread/list").map((m) => m.params)).toEqual([
    expect.objectContaining({ cwd: "/p" }),
    expect.objectContaining({ cwd: "/host/physical/project" }),
  ]);
});

test("an isolated profile catalog passes all chat IPC schemas and uses the canonical cwd", async () => {
  hostFolder = { canonicalCwd: "/host/physical/project" };
  const prototype = CodexController.prototype as unknown as {
    write(this: Controller, message: Message): Promise<void>;
  };
  const write = prototype.write;
  const wire = spyOn(prototype, "write").mockImplementation(async function (
    this: Controller,
    message: Message,
  ) {
    await write.call(this, message);
    if (!message.id) return;
    const result =
      message.method === "thread/list" &&
      (message.params as Message).cwd === hostFolder.canonicalCwd
        ? { data: [{ id: "saved", preview: "from the other profile" }] }
        : { data: [] };
    this.receive({ seq: ++lineSeq, dir: "out", message: { id: message.id, result } } as never);
  });
  try {
    const listed = await CodexController.catalog({
      workspaceId: catalogWorkspace,
      cwd: "/p",
      profileId: "isolation",
    });
    expect(listed.map(({ sessionId }) => sessionId)).toEqual(["saved"]);
    const start = catalogCalls.find(({ method }) => method === "codexStart");
    expect(start?.args).toMatchObject({ profileId: "isolation" });
    expect(catalogCalls.at(-1)).toMatchObject({
      method: "close",
      args: { tabId: start?.args.tabId },
    });
    expect(
      catalogCalls
        .filter(({ method }) => method === "send")
        .map(({ args }) => (args.message as Message).method),
    ).toEqual(["initialize", "initialized", "thread/list", "thread/list"]);
  } finally {
    wire.mockRestore();
  }
});

test("a busy metadata response blocks a historical rewind before paging", async () => {
  const turn = {
    id: "cut",
    status: "completed",
    items: [{ id: "prompt", type: "userMessage", content: [{ type: "text", text: "again" }] }],
  };
  const c = tab((message) => {
    if (message.method === "thread/resume") return { thread: { id: "t1", turns: [turn] } };
    if (message.method === "thread/read")
      return { thread: { id: "t1", status: { type: "active" } } };
  });
  await c.prepareSend();
  const item = c.model.items[0];
  if (item?.kind !== "user") throw new Error("missing test user message");
  await expect(c.rewind(item, { files: false })).rejects.toThrow("The source Codex thread is busy");
  expect(order()).not.toContain("thread/turns/list");
  expect(order()).not.toContain("thread/fork");
});

test("child events refresh only that child, including an event during its cooldown", async () => {
  jest.useFakeTimers();
  const children = ["child-a", "child-b"].map((id) => ({
    id,
    parentThreadId: "t1",
    updatedAt: 1,
    status: { type: "idle" },
  }));
  const c = tab(({ method, params }) => {
    if (method === "thread/list") return { data: children };
    if (method === "thread/read") {
      const { threadId } = params as { threadId: string };
      return { thread: { ...children.find(({ id }) => id === threadId), turns: [] } };
    }
  });
  const childRequests = () =>
    sent
      .filter(({ method }) => method === "thread/list" || method === "thread/read")
      .map(({ method, params }) => [method, (params as { threadId?: string }).threadId]);
  const flushResponses = () => new Promise<void>((resolve) => setImmediate(resolve));
  const prepared = c.prepareSend();
  await flushResponses();
  jest.advanceTimersByTime(30); // initialize reply from tab()
  await prepared;
  jest.advanceTimersByTime(500);
  await flushResponses();
  expect(childRequests()).toEqual([
    ["thread/list", undefined],
    ["thread/read", "child-a"],
    ["thread/read", "child-b"],
  ]);
  sent.length = 0;
  c.receive({
    seq: ++lineSeq,
    dir: "out",
    message: {
      method: "item/completed",
      params: { threadId: "child-a", item: { type: "agentMessage", id: "child-message" } },
    },
  } as never);
  c.receive({
    seq: ++lineSeq,
    dir: "out",
    message: {
      method: "item/agentMessage/delta",
      params: { threadId: "t1", turnId: "parent-turn", itemId: "parent-message", delta: "token" },
    },
  } as never);
  jest.advanceTimersByTime(500);
  await flushResponses();
  expect(childRequests()).toEqual([]);
  jest.advanceTimersByTime(2_000);
  await flushResponses();
  expect(childRequests()).toEqual([["thread/read", "child-a"]]);
});

test("peer history filter requests share eight real catalog lifecycles", async () => {
  const profiles = Array.from({ length: 7 }, (_, i) => ({
    id: `account-${i}`,
    name: `Account ${i}`,
    dir: `~/account-${i}`,
    agent: "codex" as const,
    color: "cyan",
  }));
  const config = { profiles, rules: [], defaults: {} };
  const workspace = {
    id: catalogWorkspace,
    rootPath: "/p",
    location: { kind: "local", rootPath: "/p" },
  } as WorkspaceMeta;
  let newest = 60;
  let name: string | undefined;
  const prototype = CodexController.prototype as unknown as {
    write(this: Controller, message: Message): Promise<void>;
  };
  const write = prototype.write;
  const wire = spyOn(prototype, "write").mockImplementation(async function (
    this: Controller,
    message: Message,
  ) {
    await write.call(this, message);
    if (!message.id) return;
    if (message.method === "thread/name/set") name = String((message.params as Message).name);
    const result =
      message.method === "thread/list"
        ? {
            data: [
              {
                id: this.profileId,
                name: this.profileId === "account-0" ? name : undefined,
                preview:
                  this.profileId === defaultProfileId("codex")
                    ? `${"long ".repeat(100)}find needle here`
                    : "ordinary",
                updatedAt: this.profileId === "account-0" ? newest : 1,
              },
            ],
          }
        : {};
    this.receive({ seq: ++lineSeq, dir: "out", message: { id: message.id, result } } as never);
  });
  const search = async (query?: string, openIn?: (id: string) => string | undefined) => {
    const listed = await peerCodexThreads(workspace, config, undefined, query);
    return pastSessionsOf(listed, workspace.rootPath, (id) => id, query, 1, openIn);
  };
  const count = () => [
    catalogCalls.filter(({ method }) => method === "codexStart").length,
    catalogCalls.filter(
      ({ method, args }) => method === "send" && (args.message as Message).method === "thread/list",
    ).length,
    catalogCalls.filter(({ method }) => method === "close").length,
  ];
  try {
    const [first, overlapping] = await Promise.all([search(), search("needle")]);
    expect(first[0]?.sessionId).toBe("account-0");
    expect(overlapping[0]?.sessionId).toBe(defaultProfileId("codex"));
    expect(count()).toEqual([8, 8, 8]);
    for (const query of ["find", "find NEED", "needle here"]) {
      const matches = await search(query, () => "open-tab");
      expect(matches[0]).toMatchObject({ sessionId: defaultProfileId("codex"), tabId: "open-tab" });
    }
    expect(count()).toEqual([8, 8, 8]);
    newest = 80;
    expect((await search())[0]?.at).toBe(80_000);
    expect(count()).toEqual([16, 16, 16]);
    const tab = new CodexController({
      workspaceId: catalogWorkspace,
      tabId: crypto.randomUUID(),
      cwd: workspace.rootPath,
      threadId: "account-0",
    });
    live.push(tab);
    useChatStore.getState().update(tab.key, (prev) => ({
      ...prev,
      phase: "ready",
      model: { ...prev.model, process: "running" },
    }));
    await tab.ask("thread/name/set", { threadId: "account-0", name: "renamed profile" });
    expect((await search("RENAMED"))[0]?.title).toBe("renamed profile");
    expect(count()).toEqual([24, 24, 24]);
  } finally {
    wire.mockRestore();
  }
});

test("replaying a Codex turn reply settles the tracked send without repeating server requests", async () => {
  const c = tab();
  const line = (dir: "sys" | "in" | "out", message: Message, replay = false) =>
    c.receive({ seq: ++lineSeq, dir, message, replay });
  onStart = () => line("sys", { event: "start" });
  await c.prepareSend();

  const wrote = Promise.withResolvers<Message>();
  codex = (message) => {
    sent.push(message);
    if (message.method === "turn/start") {
      line("in", message);
      wrote.resolve(message);
    }
  };
  const sending = c.sendWithTiming("Tracked turn", [], "next", undefined, undefined, "tracked-id");
  const request = await wrote.promise;
  c.held();
  replayResponse = () => {
    line("out", { id: request.id, result: { turn: { id: "accepted" } } }, true);
    line("out", { id: "old-ask", method: "mcpServer/elicitation/request" }, true);
    return { found: true, running: true, truncated: false, lastSeq: lineSeq };
  };

  await c.resync();
  expect(await Promise.race([sending, Bun.sleep(100).then(() => "still pending")])).toBeUndefined();
  expect(c.model.items).toContainEqual(
    expect.objectContaining({
      kind: "user",
      text: "Tracked turn",
      state: "taken",
      turnId: "accepted",
    }),
  );
  expect(sent.some(({ id }) => id === "old-ask")).toBe(false);
});

test("a failed Codex /new keeps the source history, queue, and saved thread", async () => {
  const c = tab(({ method }) => {
    if (method !== "thread/resume") return undefined;
    const item = {
      type: "userMessage",
      id: "original",
      content: [{ type: "text", text: "Source" }],
    };
    return {
      thread: { id: "t1", turns: [{ id: "old-turn", status: "completed", items: [item] }] },
    };
  });
  onStart = () => c.receive({ seq: ++lineSeq, dir: "sys", message: { event: "start" } });
  await c.prepareSend();
  const queued = { id: "held", text: "Recoverable prompt", images: [], status: "failed" as const };
  useChatStore.getState().update(c.key, (prev) => ({
    ...prev,
    queue: [queued],
  }));
  const onThread = mock(() => {});
  const onTitle = mock(() => {});
  const onMoves = mock(() => {});
  c.setHooks({ onThread, onTitle, onMoves });
  startFailure = "replacement could not start";
  onStart = undefined;
  onStop = () => c.receive({ seq: ++lineSeq, dir: "sys", message: { event: "exit", code: 0 } });

  await expect(c.newThread()).rejects.toThrow("replacement could not start");
  expect(c.currentThread()).toBe("t1");
  expect(c.model.items).toContainEqual(expect.objectContaining({ kind: "user", text: "Source" }));
  expect(c.state.queue).toEqual([queued]);
  expect(c.state.phase).toBe("failed");
  expect(onThread).not.toHaveBeenCalled();
  expect(onTitle).not.toHaveBeenCalled();
  expect(onMoves).not.toHaveBeenCalled();
});

test.each([
  ["0.170.0", true],
  ["0.166.0", false],
  [null, false],
] as const)("Codex %s checks saved turns only when paged history is available", async (version, supported) => {
  installedVersion = version;
  const prototype = CodexController.prototype as unknown as {
    write(this: Controller, message: Message): Promise<void>;
  };
  const write = prototype.write;
  const wire = spyOn(prototype, "write").mockImplementation(async function (
    this: Controller,
    message: Message,
  ) {
    await write.call(this, message);
    if (!message.id) return;
    const threadId = (message.params as Message)?.threadId;
    const turns =
      threadId === "saved"
        ? [{ id: "recorded-turn", items: [{ type: "agentMessage", text: "Recorded answer" }] }]
        : [];
    const reply =
      threadId === "missing"
        ? { error: { code: -32600, message: "no rollout found" } }
        : { result: { data: turns } };
    this.receive({ seq: ++lineSeq, dir: "out", message: { id: message.id, ...reply } });
  });
  try {
    expect(
      await CodexController.savedThreadTurns(
        { workspaceId: catalogWorkspace, cwd: "/p", profileId: "isolation" },
        ["missing", "saved", "empty"],
      ),
    ).toEqual(
      new Map(
        supported
          ? [
              [
                "saved",
                [
                  {
                    id: "recorded-turn",
                    items: [{ type: "agentMessage", text: "Recorded answer" }],
                  },
                ],
              ],
            ]
          : [],
      ),
    );
    expect(catalogCalls.filter(({ method }) => method === "codexStart")).toHaveLength(1);
    expect(catalogCalls.at(-1)?.method).toBe("close");
    const requests = catalogCalls
      .filter(({ method }) => method === "send")
      .map(({ args }) => args.message as Message);
    expect(requests.map(({ method }) => method)).toEqual([
      "initialize",
      "initialized",
      ...(supported ? Array(3).fill("thread/turns/list") : []),
    ]);
    if (supported) {
      expect(requests.at(-2)?.params).toEqual({
        threadId: "saved",
        itemsView: "summary",
        limit: 1,
      });
    }
  } finally {
    wire.mockRestore();
  }
});
