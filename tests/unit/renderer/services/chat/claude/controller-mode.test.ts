import { afterEach, describe, expect, mock, test } from "bun:test";
import type { ChatLine } from "../../../../../../src/renderer/services/chat/model";

type Message = Record<string, unknown> & {
  request_id?: string;
  request?: Record<string, unknown>;
};
const sent: Message[] = [];
let tab: { receive: (line: never) => void } | undefined;
const SETTINGS_MODE = "bypassPermissions";
let hold: Promise<void> | undefined;
let rejectInitialize = false;
let stops = 0;
let onInitialize: (() => void) | undefined;
const recorded: ChatLine[] = [];
let lineSeq = 0;

function receive(dir: ChatLine["dir"], message: Message): void {
  const line = { seq: ++lineSeq, dir, message } as ChatLine;
  recorded.push(line);
  tab?.receive(line as never);
}

async function answer(message: Message): Promise<void> {
  receive("in", message);
  if (message.request?.subtype === "initialize") onInitialize?.();
  if (rejectInitialize && message.request?.subtype === "initialize") {
    receive("out", {
      type: "control_response",
      response: { subtype: "error", request_id: message.request_id, error: "initialize refused" },
    });
    return;
  }
  await Bun.sleep(0);
  if (hold) await hold;
  const request = message.request ?? {};
  const response =
    request.subtype === "initialize"
      ? { current_permission_mode: SETTINGS_MODE }
      : request.subtype === "set_permission_mode"
        ? { mode: request.mode }
        : request.subtype === "remote_control" && request.enabled
          ? { session_url: "https://claude.ai/code/example" }
          : {};
  receive("out", {
    type: "control_response",
    response: { subtype: "success", request_id: message.request_id, response },
  });
}

const realIpc = await import("../../../../../../src/renderer/ipc/client");
mock.module("../../../../../../src/renderer/ipc/client", () => ({
  ...realIpc,
  ipcCallResult: (_channel: string, method: string, args: Record<string, unknown>) => {
    const message = args.message as Message | undefined;
    if (method === "send" && message) {
      sent.push(message);
      if (message.type === "control_request") void answer(message);
    }
    if (method === "start") {
      if (args.resetLog) recorded.length = 0;
      receive("sys", { event: "start" });
      return Promise.resolve({
        ok: true,
        value: { ok: true, version: "2.1.321", attached: false },
      });
    }
    if (method === "stop") {
      stops += 1;
      receive("sys", { event: "exit", code: 0 });
    }
    if (method === "replay") {
      for (const line of recorded) tab?.receive({ ...line, replay: true } as never);
      return Promise.resolve({
        ok: true,
        value: { found: true, running: true, truncated: false, lastSeq: lineSeq },
      });
    }
    if (method === "sessionFile") {
      return Promise.resolve({ ok: true, value: { found: true, path: `/h/${args.sessionId}` } });
    }
    if (method === "transcriptPage") {
      return Promise.resolve({ ok: true, value: { found: false, lines: [], truncated: false } });
    }
    return Promise.resolve({ ok: true, value: undefined });
  },
}));

const { ChatController } = await import(
  "../../../../../../src/renderer/services/chat/claude/controller"
);
type Controller = InstanceType<typeof ChatController>;

let tabSeq = 0;
const live: Controller[] = [];

afterEach(() => {
  for (const c of live.splice(0)) c.dispose();
  sent.length = 0;
  tab = undefined;
  hold = undefined;
  rejectInitialize = false;
  stops = 0;
  onInitialize = undefined;
  recorded.length = 0;
});

test("a rejected Claude initialize cannot write the first prompt, and retry starts fresh", async () => {
  const c = new ChatController({ workspaceId: "ws-mode", tabId: "init-failure", cwd: "/p" });
  live.push(c);
  tab = c;
  rejectInitialize = true;
  await expect(c.send("keep this draft", [], undefined, "submission")).rejects.toThrow();
  expect(c.state).toMatchObject({ phase: "failed", error: "initialize refused" });
  expect(stops).toBe(1);
  expect(sent.some((message) => message.type === "user")).toBe(false);

  rejectInitialize = false;
  await c.send("keep this draft", [], undefined, "submission");
  expect(c.state.phase).toBe("ready");
  expect(sent.filter((message) => message.request?.subtype === "initialize")).toHaveLength(2);
  expect(sent.filter((message) => message.type === "user")).toHaveLength(1);
});

async function started(): Promise<Controller> {
  const c = new ChatController({
    workspaceId: "ws-mode",
    tabId: `t${++tabSeq}`,
    cwd: "/p",
    sessionId: "s1",
  });
  live.push(c);
  tab = c;
  await c.restart();
  await settle();
  return c;
}

async function settle(): Promise<void> {
  let count = -1;
  while (count !== sent.length) {
    count = sent.length;
    await Bun.sleep(30);
  }
}

function modesAsked(): unknown[] {
  return sent
    .filter((m) => m.type === "control_request" && m.request?.subtype === "set_permission_mode")
    .map((m) => m.request?.mode);
}

describe("the permission mode of a Claude tab's program started again", () => {
  test("a restart goes on in the mode the program before had", async () => {
    const c = await started();
    expect(modesAsked()).toEqual([]);
    expect(c.state.model.permissionMode).toBe(SETTINGS_MODE);
    await c.setPermissionMode("default");
    await settle();
    sent.length = 0;
    await c.restart();
    await settle();
    expect(modesAsked()).toEqual(["default"]);
    expect(c.state.model.permissionMode).toBe("default");
  });

  test("so does a rewind", async () => {
    const c = await started();
    await c.setPermissionMode("plan");
    await settle();
    sent.length = 0;
    receive("out", {
      type: "user",
      isReplay: true,
      uuid: "m1",
      message: { role: "user", content: "again" },
    });
    c.receive({
      seq: ++lineSeq,
      dir: "out",
      replay: true,
      message: { type: "result", subtype: "success" },
    });
    c.flushNow();
    const item = c.state.model.items.find((item) => item.kind === "user" && item.uuid === "m1");
    if (item?.kind !== "user") throw new Error("missing prompt");
    await c.rewind(item, { files: false });
    await settle();
    expect(modesAsked()).toEqual(["plan"]);
    expect(c.state.model.permissionMode).toBe("plan");
  });

  test("and the conversation gone on with in another profile", async () => {
    const c = await started();
    await c.setPermissionMode("acceptEdits");
    await settle();
    sent.length = 0;
    await c.continueInProfile("work");
    await settle();
    expect(modesAsked()).toEqual(["acceptEdits"]);
    expect(c.state.model.permissionMode).toBe("acceptEdits");
  });

  test("a program that starts in that mode already is not asked", async () => {
    const c = await started();
    sent.length = 0;
    await c.restart();
    await settle();
    expect(modesAsked()).toEqual([]);
    expect(c.state.model.permissionMode).toBe(SETTINGS_MODE);
  });

  test("a mode the user picks as the program starts holds", async () => {
    const c = await started();
    await c.setPermissionMode("default");
    await settle();
    sent.length = 0;
    let settled = () => {};
    hold = new Promise((resolve) => {
      settled = resolve;
    });
    const initialized = Promise.withResolvers<void>();
    onInitialize = initialized.resolve;
    const restarting = c.restart();
    await initialized.promise;
    const picked = c.setPermissionMode("acceptEdits");
    hold = undefined;
    settled();
    await picked;
    await restarting;
    await settle();
    expect(modesAsked()).toEqual(["acceptEdits"]);
    expect(c.state.model.permissionMode).toBe("acceptEdits");
  });
});

test("concurrent Remote Control toggles apply in order", async () => {
  const c = await started();
  const first = c.setRemoteControl();
  const second = c.setRemoteControl();
  await expect(first).resolves.toEqual({ enabled: true, url: "https://claude.ai/code/example" });
  await expect(second).resolves.toEqual({ enabled: false });
  expect(
    sent
      .filter((message) => message.request?.subtype === "remote_control")
      .map((message) => message.request?.enabled),
  ).toEqual([true, false]);
  expect(c.state.model.remoteControl?.enabled).toBe(false);
});
