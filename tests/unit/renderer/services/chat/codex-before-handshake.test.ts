/**
 * A Codex program takes no request before it knows the app (initialize):
 * one sent before is refused with "Not initialized", which a tab showed as
 * an error. What a tab asks as it opens (its list of threads, its
 * defaults) waits for the introduction. The real ipc client is spread
 * under a spy, so later files keep its other exports.
 */
import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { ipcContract } from "../../../../../src/shared/ipc/contract";

// The version the app tells Codex it is.
(globalThis as { __APP_VERSION__?: string }).__APP_VERSION__ ??= "0.0.0";

type Message = Record<string, unknown>;
/** A Codex program that comes up, answering what is sent to it as the test says. */
let codex: ((message: Message) => void) | undefined;
const catalogWorkspace = "b99ee5a4-4db7-43c4-8c3f-31262141cdaa";
const catalogCalls: { method: string; args: Message }[] = [];
const contract = ipcContract.chat.call;

const realIpc = await import("../../../../../src/renderer/ipc/client");
mock.module("../../../../../src/renderer/ipc/client", () => ({
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
    if (method === "codexStart") {
      starts.push(args);
      const value = { ok: true, pid: 1, attached: false, version: null, ...hostFolder };
      return Promise.resolve({
        ok: true,
        value: catalog ? contract.codexStart.result.parse(value) : value,
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
const starts: Message[] = [];
let hostFolder: { canonicalCwd?: string } = {};

afterEach(() => {
  for (const c of live.splice(0)) c.dispose();
  codex = undefined;
  sent.length = 0;
  starts.length = 0;
  catalogCalls.length = 0;
  hostFolder = {};
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
      case "thread/read": {
        didRead();
        return pendingRead.then(() => source);
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
