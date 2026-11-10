/**
 * A mode, model or effort the user picks shows at once, not when Claude
 * Code answers; one it refuses puts back what showed, unless something
 * changed it since. The real ipc client is spread under a spy, so later
 * files keep its other exports.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";

const sent: Record<string, unknown>[] = [];

const realIpc = await import("../../../../../src/renderer/ipc/client");
mock.module("../../../../../src/renderer/ipc/client", () => ({
  ...realIpc,
  ipcCallResult: (
    _channel: string,
    method: string,
    args: { message?: Record<string, unknown> },
  ) => {
    if (method === "send" && args.message) sent.push(args.message);
    return Promise.resolve({ ok: true, value: undefined });
  },
}));

const { ChatController } = await import("../../../../../src/renderer/services/chat/controller");
const { useChatStore } = await import("../../../../../src/renderer/services/chat/store");
type Controller = InstanceType<typeof ChatController>;

let seq = 0;
const live: Controller[] = [];

function running(): Controller {
  const c = new ChatController({ workspaceId: "ws-settings", tabId: `t${++seq}`, cwd: "/p" }, {});
  useChatStore.getState().update(c.key, (prev) => ({
    ...prev,
    phase: "ready",
    version: "2.1.321",
    model: {
      ...prev.model,
      process: "running",
      permissionMode: "default",
      model: "claude-opus-5-5",
      effort: "high",
    },
  }));
  live.push(c);
  return c;
}

/** Claude Code's answer to the last request the controller wrote. */
function answer(c: Controller, error?: string): void {
  const request = sent.filter((m) => m.type === "control_request").at(-1);
  c.receive({
    seq: ++seq,
    dir: "out",
    message: {
      type: "control_response",
      response: error
        ? { subtype: "error", request_id: request?.request_id, error }
        : { subtype: "success", request_id: request?.request_id, response: {} },
    },
  });
}

afterEach(() => {
  for (const c of live.splice(0)) c.dispose();
  sent.length = 0;
});

describe("a setting the user picks", () => {
  test("shows at once, before Claude Code answers", () => {
    const c = running();
    // Left unanswered: the tab's closing ends them.
    c.setModel("claude-haiku-5-5").catch(() => {});
    c.setEffort("low").catch(() => {});
    c.setPermissionMode("plan").catch(() => {});
    const { model, effort, permissionMode } = c.state.model;
    expect({ model, effort, permissionMode }).toEqual({
      model: "claude-haiku-5-5",
      effort: "low",
      permissionMode: "plan",
    });
  });

  test("one Claude Code refuses puts back what showed", async () => {
    const c = running();
    const picked = c.setPermissionMode("bypassPermissions");
    answer(c, "Cannot set permission mode");
    await expect(picked).rejects.toThrow("Cannot set permission mode");
    expect(c.state.model.permissionMode).toBe("default");
  });

  test("a refusal leaves a later pick as it is", async () => {
    const c = running();
    const first = c.setModel("claude-haiku-5-5");
    c.setModel("claude-sonnet-5-5").catch(() => {});
    // The first request's answer: the last written is the second, so answer by hand.
    const request = sent.filter((m) => m.type === "control_request")[0];
    c.receive({
      seq: ++seq,
      dir: "out",
      message: {
        type: "control_response",
        response: { subtype: "error", request_id: request?.request_id, error: "nope" },
      },
    });
    await expect(first).rejects.toThrow("nope");
    expect(c.state.model.model).toBe("claude-sonnet-5-5");
  });

  test("an answer keeps it", async () => {
    const c = running();
    const picked = c.setEffort("max");
    answer(c);
    await picked;
    expect(c.state.model.effort).toBe("max");
  });
});
