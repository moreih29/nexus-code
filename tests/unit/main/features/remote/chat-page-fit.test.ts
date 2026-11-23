import { describe, expect, test } from "bun:test";
import type { ChatPage, ViewToolCall } from "../../../../../packages/remote-protocol/src";
import type { CliServices } from "../../../../../src/main/features/cli/context";
import { ChatWatches } from "../../../../../src/main/features/remote/chat-watches";
import { fitPage, fitsAsResult, readChat } from "../../../../../src/main/features/remote/serve";

const MB = 1024 * 1024;

function tool(id: string, text: string, parent: string | null = null): ViewToolCall {
  return {
    id,
    name: "Bash",
    input: { command: "run" },
    status: "done",
    result: { text, isError: false, images: [], structured: { stdout: text } },
    parentToolUseId: parent,
  };
}

function bigPage(calls: number, resultChars: number, subCalls = 0, replyChars = 10): ChatPage {
  const tools: Record<string, ViewToolCall> = {};
  for (let i = 0; i < calls; i++) tools[`t${i}`] = tool(`t${i}`, "r".repeat(resultChars));
  for (let i = 0; i < subCalls; i++) {
    tools[`s${i}`] = tool(`s${i}`, "s".repeat(resultChars), "t0");
  }
  return {
    status: { running: false, permissions: [] } as unknown as ChatPage["status"],
    start: 41,
    total: 42,
    items: [
      {
        kind: "assistant",
        key: "a1",
        messageId: "m1",
        blocks: [{ kind: "text", text: "x".repeat(replyChars) }],
        at: 0,
      } as unknown as ChatPage["items"][number],
    ],
    tools,
    tasks: {},
    agentItems: subCalls ? { t0: [] } : {},
  };
}

function services(page: (limit: number) => ChatPage) {
  const asked: string[] = [];
  const s = {
    listWorkspaces: () => [{ id: "w1", name: "app", rootPath: "/src/app" }],
    ui: async (op: string, args: Record<string, unknown>) => {
      if (op === "tabs.list") return { tabs: [{ id: "t1", type: "claude", title: "Chat" }] };
      asked.push(op);
      if (op === "chat.page" || op === "chat.watch") return page(Number(args.limit));
      return {};
    },
  } as unknown as CliServices;
  return { s, asked };
}

describe("fitPage", () => {
  test("cuts the tools' results, marked, before anything else", () => {
    const page = bigPage(20, 64 * 1024);
    expect(fitsAsResult(page)).toBe(false);
    const fitted = fitPage(page);
    expect(fitted).not.toBeNull();
    expect(fitsAsResult(fitted)).toBe(true);
    const cut = fitted?.tools.t3?.result;
    expect(cut?.truncated).toBe(true);
    expect(cut?.text.length).toBe(8 * 1024);
    expect(cut && "structured" in cut).toBe(false);
    expect(fitted?.items).toEqual(page.items);
  });

  test("leaves a subagent's run out when its calls alone are too many", () => {
    const page = bigPage(1, 10, 20_000);
    const fitted = fitPage(page);
    expect(fitted).not.toBeNull();
    expect(fitted?.agentItems).toEqual({});
    expect(Object.keys(fitted?.tools ?? {})).toEqual(["t0"]);
  });

  test("a result that is short and plain is kept as it is", () => {
    const page = bigPage(1, 10);
    page.tools.t0 = { ...tool("t0", "ok"), result: { text: "ok", isError: false, images: [] } };
    expect(cutTools(fitPage({ ...page, items: page.items }))).toBe(page.tools.t0);
  });

  test("null when the reply itself is too large", () => {
    expect(fitPage(bigPage(1, 10, 0, 2 * MB))).toBeNull();
  });
});

function cutTools(page: ChatPage | null) {
  return page?.tools.t0;
}

describe("a chat read further back", () => {
  test("an item too large as it is comes with less of it", async () => {
    const { s } = services(() => bigPage(30, 64 * 1024));
    const page = await readChat(s, { workspaceId: "w1", tabId: "t1", before: 42, limit: 60 });
    expect(page.items).toHaveLength(1);
    expect(page.tools.t0?.result?.truncated).toBe(true);
  });

  test("one that can't be made to fit is still refused", async () => {
    const { s } = services(() => bigPage(1, 10, 0, 2 * MB));
    await expect(
      readChat(s, { workspaceId: "w1", tabId: "t1", before: 42, limit: 60 }),
    ).rejects.toThrow("too large to send");
  });
});

describe("a chat watched", () => {
  test("a first page of one item too large comes with less of it, and stays watched", async () => {
    const { s, asked } = services(() => bigPage(30, 64 * 1024));
    const watches = new ChatWatches({ services: () => s, notify: async () => true });
    const page = await watches.watch("phone", { workspaceId: "w1", tabId: "t1", limit: 30 });
    expect(page.tools.t0?.result?.truncated).toBe(true);
    expect(asked.filter((op) => op === "chat.unwatch")).toHaveLength(0);
  });
});
