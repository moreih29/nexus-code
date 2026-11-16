/**
 * The permission mode a Claude tab's program goes on in when the app starts
 * one again in the tab (a restart, a rewind, another profile): the one the
 * program before had, not the settings' default a new conversation starts
 * in. The tab's first program starts as the settings say.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import type { UserItem } from "../../../../../src/renderer/services/chat/model";

type Message = Record<string, unknown> & {
  request_id?: string;
  request?: Record<string, unknown>;
};
const sent: Message[] = [];
/** The tab whose program answers what it is asked. */
let tab: { receive: (line: never) => void } | undefined;
/** The mode the user's settings start a program in. */
const SETTINGS_MODE = "bypassPermissions";
/** While set, the program answers nothing until it settles. */
let hold: Promise<void> | undefined;
let lineSeq = 0;

/**
 * The program's answer to a request, after the tab's log has the request:
 * the mode it starts in, the mode it switched to.
 */
async function answer(message: Message): Promise<void> {
  tab?.receive({ seq: ++lineSeq, dir: "in", message } as never);
  await Bun.sleep(0);
  if (hold) await hold;
  const request = message.request ?? {};
  const response =
    request.subtype === "initialize"
      ? { current_permission_mode: SETTINGS_MODE }
      : request.subtype === "set_permission_mode"
        ? { mode: request.mode }
        : {};
  tab?.receive({
    seq: ++lineSeq,
    dir: "out",
    message: {
      type: "control_response",
      response: { subtype: "success", request_id: message.request_id, response },
    },
  } as never);
}

const realIpc = await import("../../../../../src/renderer/ipc/client");
mock.module("../../../../../src/renderer/ipc/client", () => ({
  ...realIpc,
  ipcCallResult: (_channel: string, method: string, args: Record<string, unknown>) => {
    const message = args.message as Message | undefined;
    if (method === "send" && message) {
      sent.push(message);
      if (message.type === "control_request") void answer(message);
    }
    if (method === "start") {
      return Promise.resolve({
        ok: true,
        value: { ok: true, version: "2.1.321", attached: false },
      });
    }
    if (method === "replay") {
      return Promise.resolve({
        ok: true,
        value: { found: false, running: false, truncated: false, lastSeq: 0 },
      });
    }
    if (method === "sessionFile") {
      return Promise.resolve({ ok: true, value: { found: true, path: `/h/${args.sessionId}` } });
    }
    if (method === "transcript") {
      return Promise.resolve({ ok: true, value: { found: false, lines: [], truncated: false } });
    }
    return Promise.resolve({ ok: true, value: undefined });
  },
}));

const { ChatController } = await import("../../../../../src/renderer/services/chat/controller");
type Controller = InstanceType<typeof ChatController>;

let tabSeq = 0;
const live: Controller[] = [];

afterEach(() => {
  for (const c of live.splice(0)) c.dispose();
  sent.length = 0;
  tab = undefined;
  hold = undefined;
});

/** A tab going on with a session, its first program started and in the settings' mode. */
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

/** Waits until the program is asked nothing more and its answers are in the model. */
async function settle(): Promise<void> {
  let count = -1;
  while (count !== sent.length) {
    count = sent.length;
    await Bun.sleep(30);
  }
}

/** The modes the program was asked to switch to since the list was emptied. */
function modesAsked(): unknown[] {
  return sent
    .filter((m) => m.type === "control_request" && m.request?.subtype === "set_permission_mode")
    .map((m) => m.request?.mode);
}

describe("the permission mode of a Claude tab's program started again", () => {
  test("a restart goes on in the mode the program before had", async () => {
    const c = await started();
    // The tab's first program: the settings say.
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
    const item = { kind: "user", key: "u1", uuid: "m1", text: "again" } as UserItem;
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
    await c.restart();
    const picked = c.setPermissionMode("acceptEdits");
    hold = undefined;
    settled();
    await picked;
    await settle();
    expect(modesAsked()).toEqual(["acceptEdits"]);
    expect(c.state.model.permissionMode).toBe("acceptEdits");
  });
});
