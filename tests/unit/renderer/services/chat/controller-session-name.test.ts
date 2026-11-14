/**
 * A name given to a Claude tab before its conversation began names the
 * session it starts: there was no session to name then, and Claude's title
 * from the first message took the name's place. The real ipc client is
 * spread under a spy, so later files keep its other exports.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";

type Message = Record<string, unknown> & { request?: Record<string, unknown> };
const sent: Message[] = [];

const realIpc = await import("../../../../../src/renderer/ipc/client");
mock.module("../../../../../src/renderer/ipc/client", () => ({
  ...realIpc,
  ipcCallResult: (_channel: string, method: string, args: { message?: Message }) => {
    if (method === "send" && args.message) sent.push(args.message);
    if (method === "start") {
      return Promise.resolve({
        ok: true,
        value: { ok: true, version: "2.1.321", attached: false },
      });
    }
    return Promise.resolve({ ok: true, value: undefined });
  },
}));

const { ChatController } = await import("../../../../../src/renderer/services/chat/controller");
type Controller = InstanceType<typeof ChatController>;

let seq = 0;
const live: Controller[] = [];

afterEach(() => {
  for (const c of live.splice(0)) c.dispose();
  sent.length = 0;
});

const requests = () => sent.filter((m) => m.type === "control_request");
const subtypes = () => requests().map((m) => m.request?.subtype);

/** Answers every request the controller has sent and not had answered, as they come. */
async function answerAll(c: Controller, from: number): Promise<number> {
  let n = from;
  for (let idle = 0; idle < 20; idle++) {
    await Bun.sleep(1);
    while (requests().length > n) {
      const request = requests()[n++] as Message;
      c.receive({
        seq: ++seq,
        dir: "out",
        message: {
          type: "control_response",
          response: { subtype: "success", request_id: request.request_id, response: {} },
        },
      });
      idle = 0;
    }
  }
  return n;
}

/** Sends the first message and has the program start a session for it. */
async function firstMessage(c: Controller, sessionId: string): Promise<void> {
  const sending = c.send("hi");
  let n = await answerAll(c, 0);
  await sending;
  c.receive({ seq: ++seq, dir: "sys", message: { event: "start" } });
  c.receive({
    seq: ++seq,
    dir: "out",
    message: { type: "system", subtype: "init", session_id: sessionId },
  });
  c.flushNow();
  n = await answerAll(c, n);
}

function tab(): Controller {
  const c = new ChatController({ workspaceId: "ws-named", tabId: `t${++seq}`, cwd: "/p" });
  live.push(c);
  return c;
}

describe("a Claude tab's session name", () => {
  test("given before the first message, names the session it starts", async () => {
    const c = tab();
    expect(await c.renameSession("NexusCloud-P")).toBe(false);
    await firstMessage(c, "s-named");
    const rename = requests().find((m) => m.request?.subtype === "rename_session");
    expect(rename?.request).toMatchObject({ title: "NexusCloud-P", session_id: "s-named" });
    expect(subtypes()).not.toContain("generate_session_title");
  });

  test("not given, is the title Claude makes from the first message", async () => {
    const c = tab();
    await firstMessage(c, "s-titled");
    expect(subtypes()).toContain("generate_session_title");
    expect(subtypes()).not.toContain("rename_session");
  });
});
