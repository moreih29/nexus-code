/**
 * The model and effort the user picks in a Claude tab are the tab's: the
 * tab is told to keep them, and a program started for it again (a restart
 * of the app, a switch of profile) is given them after the settings'
 * defaults, which would otherwise put back the default effort.
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
const { useTabsStore } = await import("../../../../../src/renderer/state/stores/tabs");
type Controller = InstanceType<typeof ChatController>;

let seq = 0;
const live: Controller[] = [];

afterEach(() => {
  for (const c of live.splice(0)) c.dispose();
  sent.length = 0;
});

function requests(): Message[] {
  return sent.filter((m) => m.type === "control_request");
}

/**
 * Waits for the controller's next request, and answers it with `response`,
 * or refuses it with `error`.
 */
async function answerNext(
  c: Controller,
  answered: number,
  response: Record<string, unknown> = {},
  error?: string,
): Promise<Record<string, unknown>> {
  for (let i = 0; i < 50 && requests().length <= answered; i++) await Bun.sleep(1);
  const request = requests()[answered];
  if (!request) throw new Error(`no request after ${answered}`);
  c.receive({
    seq: ++seq,
    dir: "out",
    message: {
      type: "control_response",
      response: error
        ? { subtype: "error", request_id: request.request_id, error }
        : { subtype: "success", request_id: request.request_id, response },
    },
  });
  return request.request ?? {};
}

/**
 * The requests a started program's initialize sends, answered in turn;
 * `refuse` names the one Claude Code refuses.
 */
async function startUp(
  c: Controller,
  { init = {}, refuse }: { init?: Record<string, unknown>; refuse?: string } = {},
): Promise<Record<string, unknown>[]> {
  const restarted = c.restart();
  const asked: Record<string, unknown>[] = [];
  asked.push(await answerNext(c, 0, init));
  // The user's settings set effort high; the program runs at xhigh.
  asked.push(
    await answerNext(c, 1, {
      effective: { effortLevel: "high" },
      applied: { model: "claude-opus-5-5", effort: "xhigh" },
    }),
  );
  for (let n = 2; n < 6; n++) {
    await Bun.sleep(1);
    const next = requests()[n]?.request;
    if (!next) break;
    asked.push(await answerNext(c, n, {}, next.subtype === refuse ? "refused" : undefined));
  }
  await restarted;
  return asked;
}

describe("the model and effort picked in a Claude tab", () => {
  test("are told to the tab to keep once taken, and one refused is not", async () => {
    const chosen: unknown[] = [];
    const c = new ChatController(
      { workspaceId: "ws-chosen", tabId: `t${++seq}`, cwd: "/p" },
      { onChosen: (pick) => chosen.push(pick) },
    );
    live.push(c);
    await startUp(c);
    let n = requests().length;
    const model = c.setModel("claude-haiku-5-5");
    await answerNext(c, n++);
    await model;
    const effort = c.setEffort("low");
    await answerNext(c, n++);
    await effort;
    const refused = c.setEffort("max");
    await answerNext(c, n++, {}, "not for this model");
    await expect(refused).rejects.toThrow("not for this model");
    expect(chosen).toEqual([{ model: "claude-haiku-5-5" }, { effort: "low" }]);
    // A fork of the tab starts with them too.
    expect(c.inherited().chosen).toEqual({ model: "claude-haiku-5-5", effort: "low" });
  });

  test("a refused one leaves the rest of the start, Remote Control included", async () => {
    const c = new ChatController({
      workspaceId: "ws-chosen",
      tabId: `t${++seq}`,
      cwd: "/p",
      chosen: { model: "gone-model", effort: "low" },
    });
    live.push(c);
    const asked = await startUp(c, {
      init: { remote_control_available: true, remote_control_auto_enable: true },
      refuse: "set_model",
    });
    expect(asked.map((r) => r.subtype)).toEqual([
      "initialize",
      "get_settings",
      "apply_flag_settings",
      "apply_flag_settings",
      "set_model",
      "remote_control",
    ]);
  });

  test("are given to its next program after the settings' default effort", async () => {
    const c = new ChatController({
      workspaceId: "ws-chosen",
      tabId: `t${++seq}`,
      cwd: "/p",
      chosen: { model: "claude-haiku-5-5", effort: "low" },
    });
    live.push(c);
    const asked = await startUp(c);
    expect(asked.map((r) => r.subtype)).toEqual([
      "initialize",
      "get_settings",
      "apply_flag_settings",
      "apply_flag_settings",
      "set_model",
    ]);
    expect(asked[2]?.settings).toEqual({ effortLevel: "high" });
    expect(asked[3]?.settings).toEqual({ effortLevel: "low" });
    expect(asked[4]?.model).toBe("claude-haiku-5-5");
  });

  test("still go to the program when the settings' effort is refused", async () => {
    const c = new ChatController({
      workspaceId: "ws-chosen",
      tabId: `t${++seq}`,
      cwd: "/p",
      chosen: { model: "claude-haiku-5-5", effort: "low" },
    });
    live.push(c);
    const asked = await startUp(c, { refuse: "apply_flag_settings" });
    expect(asked.map((r) => r.subtype)).toEqual([
      "initialize",
      "get_settings",
      "apply_flag_settings",
      "apply_flag_settings",
      "set_model",
    ]);
    expect(asked[3]?.settings).toEqual({ effortLevel: "low" });
  });

  test("reach the program before a message sent as it starts", async () => {
    const c = new ChatController({
      workspaceId: "ws-chosen",
      tabId: `t${++seq}`,
      cwd: "/p",
      chosen: { model: "claude-haiku-5-5", effort: "low" },
    });
    live.push(c);
    const sending = c.send("hi");
    await answerNext(c, 0);
    await answerNext(c, 1, { effective: { effortLevel: "high" } });
    for (let n = 2; n < 5; n++) await answerNext(c, n);
    await sending;
    const order = sent.map((m) => (m.type === "control_request" ? m.request?.subtype : m.type));
    expect(order.indexOf("user")).toBeGreaterThan(order.indexOf("set_model"));
  });

  test("leave a tab without a pick to the settings", async () => {
    const c = new ChatController({ workspaceId: "ws-chosen", tabId: `t${++seq}`, cwd: "/p" });
    live.push(c);
    const asked = await startUp(c);
    expect(asked.map((r) => r.subtype)).toEqual([
      "initialize",
      "get_settings",
      "apply_flag_settings",
    ]);
    expect(asked[2]?.settings).toEqual({ effortLevel: "high" });
  });
});

describe("the pick a tab keeps", () => {
  test("goes over the one before, and on with the session, a rewind and another profile", () => {
    const tabs = () => useTabsStore.getState();
    const tab = tabs().createTab("ws-chosen-store", {
      type: "claude",
      props: { cwd: "/p", sessionId: "old" },
    });
    tabs().setChatChosen("ws-chosen-store", tab.id, { model: "claude-haiku-5-5" });
    tabs().setChatChosen("ws-chosen-store", tab.id, { effort: "low" });
    tabs().setChatChosen("ws-chosen-store", tab.id, { effort: "medium" });
    tabs().setClaudeTarget("ws-chosen-store", tab.id, { fork: { sessionId: "old" } });
    tabs().setChatProfile("ws-chosen-store", tab.id, "work");
    tabs().setClaudeSession("ws-chosen-store", tab.id, "copy");
    const props = tabs().byWorkspace["ws-chosen-store"]?.[tab.id]?.props as {
      chosen?: { model?: string; effort?: string };
    };
    expect(props.chosen).toEqual({ model: "claude-haiku-5-5", effort: "medium" });
  });
});
