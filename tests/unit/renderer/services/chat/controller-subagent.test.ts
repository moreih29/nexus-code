/**
 * A subagent that ended, in a conversation read from its transcript, has
 * none of its messages there: Claude Code keeps them in a file of their
 * own, which the tab reads once the subagent is shown, into its history.
 * The real ipc client is spread under a spy, so later files keep its other
 * exports.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";

const asked: Record<string, unknown>[] = [];
let found = true;

const realIpc = await import("../../../../../src/renderer/ipc/client");
mock.module("../../../../../src/renderer/ipc/client", () => ({
  ...realIpc,
  ipcCallResult: (_channel: string, method: string, args: Record<string, unknown>) => {
    if (method === "subagentTranscript") {
      asked.push(args);
      return Promise.resolve({
        ok: true,
        value: {
          found: found && args.sessionId === "s-sub",
          truncated: false,
          lines: [
            {
              type: "assistant",
              uuid: "x1",
              timestamp: "2026-11-17T01:00:05.000Z",
              message: { id: "m1", content: [{ type: "text", text: "Done looking." }] },
            },
          ],
        },
      });
    }
    return Promise.resolve({ ok: true, value: undefined });
  },
}));

const { ChatController } = await import("../../../../../src/renderer/services/chat/controller");
const { useChatStore, chatKey } = await import("../../../../../src/renderer/services/chat/store");
const { emptyModel } = await import("../../../../../src/renderer/services/chat/model");
type Controller = InstanceType<typeof ChatController>;

const live: Controller[] = [];

afterEach(() => {
  for (const c of live.splice(0)) c.dispose();
  asked.length = 0;
  found = true;
});

function tabWithHistory(tabId: string, status: "done" | "running" = "done"): Controller {
  const c = new ChatController({ workspaceId: "ws-sub", tabId, cwd: "/p", sessionId: "s-sub" });
  live.push(c);
  useChatStore.getState().update(chatKey("ws-sub", tabId), (prev) => ({
    ...prev,
    history: {
      ...emptyModel(),
      items: [
        {
          kind: "assistant",
          key: "a1",
          messageId: "m0",
          blocks: [{ type: "tool", toolUseId: "agent1" }],
        },
      ],
      tools: {
        agent1: {
          id: "agent1",
          name: "Agent",
          input: { description: "Look around", prompt: "Look." },
          status,
          parentToolUseId: null,
          result: {
            text: "",
            isError: false,
            images: [],
            structured: { status: "completed", agentId: "a9f" },
          },
        },
      },
    },
  }));
  return c;
}

describe("a subagent read from its file", () => {
  test("goes in the history under its Agent call, asked by its agent id", async () => {
    const c = tabWithHistory("t-sub");
    await c.loadSubagent("agent1");
    expect(asked).toEqual([
      { workspaceId: "ws-sub", sessionId: "s-sub", agentId: "a9f", toolUseId: "agent1" },
    ]);
    const history = useChatStore.getState().tabs[chatKey("ws-sub", "t-sub")]?.history;
    expect(history?.agentItems.agent1?.[0]?.blocks).toEqual([
      { type: "text", text: "Done looking." },
    ]);
    // What the history had stays.
    expect(history?.items).toHaveLength(1);
    // Read, it is not asked for again.
    await c.loadSubagent("agent1");
    expect(asked).toHaveLength(1);
  });

  test("one found nowhere is asked for once, and one still running not at all", async () => {
    found = false;
    const c = tabWithHistory("t-none");
    await Promise.all([c.loadSubagent("agent1"), c.loadSubagent("agent1")]);
    await c.loadSubagent("agent1");
    expect(asked).toHaveLength(1);
    const running = tabWithHistory("t-running", "running");
    await running.loadSubagent("agent1");
    expect(asked).toHaveLength(1);
  });
});
