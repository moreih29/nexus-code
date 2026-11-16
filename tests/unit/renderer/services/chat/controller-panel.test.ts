/**
 * What the side panel asks Claude for: its MCP servers only once the
 * program's initialize ended, as asked before it they are not up yet and
 * come back as none. The real ipc client is spread under a spy, so later
 * files keep its other exports.
 */
import { afterEach, describe, expect, jest, mock, test } from "bun:test";

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

const { ChatController, signInPageOf } = await import(
  "../../../../../src/renderer/services/chat/controller"
);
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

let lineSeq = 0;

/** Answers the last mcp_status asked, as the program does, with `servers`. */
function answerMcp(c: Controller, servers: unknown[]): void {
  const request = sent
    .filter((m) => m.type === "control_request")
    .findLast((m) => (m.request as { subtype: string }).subtype === "mcp_status");
  const response = {
    subtype: "success",
    request_id: request?.request_id,
    response: { mcpServers: servers },
  };
  c.receive({
    seq: ++lineSeq,
    dir: "out",
    message: { type: "control_response", response },
  } as never);
}

afterEach(() => {
  jest.useRealTimers();
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

  test("said to be none as the program came up, are asked again a few times, then left", async () => {
    jest.useFakeTimers();
    const { c, ended } = starting();
    ended();
    c.refreshPanel(["mcp"]);
    await settle();
    const count = () => asked().filter((s) => s === "mcp_status").length;
    expect(count()).toBe(1);
    // Still coming up: none, again and again, till the asks run out.
    for (let i = 2; i <= 5; i++) {
      answerMcp(c, []);
      await settle();
      jest.advanceTimersByTime(2_000);
      await settle();
      expect(count()).toBe(i);
    }
    answerMcp(c, []);
    await settle();
    jest.advanceTimersByTime(10_000);
    await settle();
    expect(count()).toBe(5);
  });

  test("once some are said, are not asked again", async () => {
    jest.useFakeTimers();
    const { c, ended } = starting();
    ended();
    c.refreshPanel(["mcp"]);
    await settle();
    answerMcp(c, [{ name: "github", status: "connected" }]);
    await settle();
    jest.advanceTimersByTime(10_000);
    await settle();
    expect(asked().filter((s) => s === "mcp_status")).toHaveLength(1);
  });
});

describe("an MCP server's sign-in page", () => {
  test("comes back to the redirect unless a connector's or one with its own callback", () => {
    expect(signInPageOf({ authUrl: "https://a.example/auth" })).toEqual({
      authUrl: "https://a.example/auth",
      back: true,
    });
    expect(signInPageOf({ authUrl: "https://a.example/auth", callbackExpected: false })).toEqual({
      authUrl: "https://a.example/auth",
      back: false,
    });
    expect(signInPageOf({ authUrl: "https://a.example/auth", callbackPort: 4567 })).toEqual({
      authUrl: "https://a.example/auth",
      back: false,
    });
  });

  test("is none when signed in already", () => {
    expect(signInPageOf({})).toEqual({ back: false });
    expect(signInPageOf(undefined)).toEqual({ back: false });
  });
});
