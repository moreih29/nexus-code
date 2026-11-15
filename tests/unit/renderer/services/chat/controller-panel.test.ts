/**
 * What the side panel asks Claude for: its MCP servers only once the
 * program's initialize ended, as asked before it they are not up yet and
 * come back as none. The real ipc client is spread under a spy, so later
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

/** A tab whose program runs, its initialize still going until `ended` is called. */
function starting(): { c: Controller; ended: () => void } {
  const c = new ChatController({ workspaceId: "ws-panel", tabId: `t${++seq}`, cwd: "/p" }, {});
  useChatStore.getState().update(c.key, (prev) => ({
    ...prev,
    phase: "ready",
    version: "2.1.321",
    model: { ...prev.model, process: "running" },
  }));
  let ended = () => {};
  (c as unknown as { initializing: Promise<void> }).initializing = new Promise<void>((resolve) => {
    ended = resolve;
  });
  live.push(c);
  return { c, ended };
}

function asked(): string[] {
  return sent
    .filter((message) => message.type === "control_request")
    .map((message) => (message.request as { subtype: string }).subtype);
}

const settle = async () => {
  for (let i = 0; i < 4; i++) await Promise.resolve();
};

afterEach(() => {
  for (const c of live.splice(0)) c.dispose();
  sent.length = 0;
});

describe("the side panel's MCP servers", () => {
  test("are asked for once the program's initialize ended, not before", async () => {
    const { c, ended } = starting();
    c.refreshPanel(["mcp"]);
    await settle();
    expect(asked()).not.toContain("mcp_status");
    ended();
    await settle();
    expect(asked()).toContain("mcp_status");
  });

  test("are not asked for when the program went before its initialize ended", async () => {
    const { c, ended } = starting();
    c.refreshPanel(["mcp"]);
    useChatStore.getState().update(c.key, (prev) => ({
      ...prev,
      model: { ...prev.model, process: "exited" },
    }));
    ended();
    await settle();
    expect(asked()).not.toContain("mcp_status");
  });
});
