import { afterAll, beforeEach, describe, expect, spyOn, test } from "bun:test";

const globals = globalThis as Record<string, unknown>;
const saved = globals.window;
const told: unknown[] = [];
globals.window = {
  ...((saved as object | undefined) ?? {}),
  ipc: {
    call: async (channel: string, method: string, args: unknown) => {
      if (channel === "remote" && method === "chatSourcesChanged") told.push(args);
      return channel === "chat" && method === "attachRoot" ? { root: "/tmp/attach" } : {};
    },
    cancel: () => {},
    on: () => () => {},
    listen: () => () => {},
  },
};
afterAll(() => {
  stopWatchingChatSources();
  globals.window = saved;
});

const { chatHandlers } = await import("../../../../../src/renderer/services/cli/chat-actions");
const { ChatController } = await import(
  "../../../../../src/renderer/services/chat/claude/controller"
);
const { linkCandidates, sourcePresent, stopWatchingChatSources, watchChatSources } = await import(
  "../../../../../src/renderer/services/cli/file-links"
);
const { useTabsStore } = await import("../../../../../src/renderer/state/stores/tabs");
const { useWorkspacesStore } = await import("../../../../../src/renderer/state/stores/workspaces");
const { chatKey, emptyTabState, useChatStore } = await import(
  "../../../../../src/renderer/services/chat/store"
);
const { emptyModel } = await import("../../../../../src/renderer/services/chat/model");

const ROOT = "/Users/me/work";

function said(key: string, text: string, ...tools: string[]) {
  return {
    kind: "assistant",
    key,
    messageId: `m-${key}`,
    blocks: [{ type: "text", text }, ...tools.map((id) => ({ type: "tool", toolUseId: id }))],
  };
}

function tool(id: string, name: string, input: Record<string, unknown>, extra = {}) {
  return { id, name, input, status: "done", parentToolUseId: null, ...extra };
}

function chatState() {
  return {
    ...emptyTabState(),
    model: {
      ...emptyModel(),
      items: [
        said("a1", "Made [the chart](/tmp/out/chart.png#L1) and `notes.md`.", "r1"),
        { kind: "received", key: "rc", from: { kind: "tab" }, text: "see [it](../shared/x.txt)" },
        { kind: "task_end", key: "te", taskId: "j1", status: "done", summary: "[log](/tmp/j.log)" },
        {
          kind: "user",
          key: "u1",
          text: "hi\n\n@docs/b.md @../work-other/c.md @/tmp/attach/w1/c1/1/copy.md",
          images: [],
          state: "taken",
        },
      ],
      tools: {
        r1: tool("r1", "Read", { file_path: `${ROOT}/notes.md` }),
        w1: tool("w1", "Write", { file_path: "/tmp/out/made.txt" }),
        e1: tool("e1", "Edit", { file_path: "/tmp/out/edited.txt" }),
        b1: tool(
          "b1",
          "Bash",
          { command: "ls", cwd: "/tmp/elsewhere" },
          {
            result: { text: "wrote [r](report.md)", images: [] },
          },
        ),
        p1: tool("p1", "ExitPlanMode", { plan: "Then open [plan file](/tmp/plan/a.md)." }),
        g1: tool("g1", "Read", { file_path: "/tmp/looked/secret.txt" }),
      },
      streaming: {
        messageId: "m-live",
        blocks: { 0: { type: "text", text: "[now](/tmp/live.md)" } },
      },
      tasks: {
        j1: {
          taskId: "j1",
          type: "local_bash",
          description: "j",
          status: "done",
          outputFile: "/tmp/j.out",
        },
      },
      permissions: [
        {
          requestId: "q1",
          toolName: "ExitPlanMode",
          input: { plan: "Asking about [it](/tmp/plan/b.md)" },
          suggestions: [],
          toolUseId: "p2",
        },
      ],
    },
  };
}

function source() {
  return { agent: "claude", title: "c", chat: useChatStore.getState().tabs[chatKey("w1", "c1")] };
}

beforeEach(() => {
  useWorkspacesStore.setState({
    workspaces: [{ id: "w1", name: "work", rootPath: ROOT }],
  } as never);
  useTabsStore.setState({
    byWorkspace: { w1: { c1: { id: "c1", type: "claude", title: "c", props: { cwd: ROOT } } } },
  } as never);
  useChatStore.setState({ tabs: { [chatKey("w1", "c1")]: chatState() } } as never);
});

describe("where a link another device names came from in a chat", () => {
  test("is found in the part it names, and only there", () => {
    const at = (href: string, from: Record<string, unknown>) =>
      linkCandidates(source() as never, ROOT, href, from as never);
    expect(at("/tmp/out/chart.png", { kind: "answer", itemKey: "a1" })).toEqual([
      "/tmp/out/chart.png",
    ]);
    expect(at("/tmp/out/chart.png#L1", { kind: "answer", itemKey: "a1" })).toEqual([
      "/tmp/out/chart.png",
    ]);
    expect(at("notes.md", { kind: "answer", itemKey: "a1" })).toEqual([
      `${ROOT}/notes.md`,
      "/tmp/elsewhere/notes.md",
    ]);
    expect(at("/tmp/out/chart.png", { kind: "received", itemKey: "rc" })).toBeNull();
    expect(at("/tmp/out/chart.png", { kind: "answer", itemKey: "missing" })).toBeNull();
    expect(at("../shared/x.txt", { kind: "received", itemKey: "rc" })).toEqual([
      "/Users/me/shared/x.txt",
    ]);
    expect(at("/tmp/j.log", { kind: "taskEnd", itemKey: "te" })).toEqual(["/tmp/j.log"]);
    expect(at("/tmp/live.md", { kind: "streaming", messageId: "m-live" })).toEqual([
      "/tmp/live.md",
    ]);
    expect(at("/tmp/out/made.txt", { kind: "tool", toolUseId: "w1" })).toEqual([
      "/tmp/out/made.txt",
    ]);
    expect(at("report.md", { kind: "tool", toolUseId: "b1" })).toEqual([
      "/tmp/elsewhere/report.md",
    ]);
    expect(at("/tmp/plan/a.md", { kind: "tool", toolUseId: "p1" })).toEqual(["/tmp/plan/a.md"]);
    expect(at("/tmp/plan/b.md", { kind: "tool", toolUseId: "p2" })).toEqual(["/tmp/plan/b.md"]);
    expect(at("/tmp/out/made.txt", { kind: "tool", toolUseId: "e1" })).toBeNull();
    expect(at("/tmp/j.out", { kind: "job", taskId: "j1" })).toEqual(["/tmp/j.out"]);
    expect(at("/tmp/out/edited.txt", { kind: "change" })).toEqual(["/tmp/out/edited.txt"]);
    expect(at("/tmp/out/made.txt", { kind: "change" })).toEqual(["/tmp/out/made.txt"]);
    expect(at("/tmp/looked/secret.txt", { kind: "change" })).toBeNull();
  });

  test("a part still in the chat is present; one rewound away is not", () => {
    const present = (from: Record<string, unknown>) =>
      sourcePresent(source() as never, from as never);
    expect(present({ kind: "answer", itemKey: "a1" })).toBe(true);
    expect(present({ kind: "answer", itemKey: "rc" })).toBe(false);
    expect(present({ kind: "tool", toolUseId: "p2" })).toBe(true);
    expect(present({ kind: "streaming", messageId: "m-live" })).toBe(true);
    expect(present({ kind: "job", taskId: "j1" })).toBe(true);
    const chat = useChatStore.getState().tabs[chatKey("w1", "c1")];
    useChatStore.setState({
      tabs: {
        [chatKey("w1", "c1")]: {
          ...chat,
          model: { ...chat.model, items: chat.model.items.slice(1), tools: {}, streaming: null },
        },
      },
    } as never);
    expect(present({ kind: "answer", itemKey: "a1" })).toBe(false);
    expect(present({ kind: "tool", toolUseId: "w1" })).toBe(false);
    expect(present({ kind: "streaming", messageId: "m-live" })).toBe(false);
  });

  test("the chat.fileLinks op accepts workspace attachments and outside slot copies", async () => {
    const open = spyOn(ChatController.prototype, "openToRead").mockResolvedValue(undefined);
    const user = { kind: "user", itemKey: "u1" } as const;
    try {
      expect(
        await chatHandlers["chat.fileLinks"]({
          workspaceId: "w1",
          tabId: "c1",
          links: [
            { href: "docs/b.md", source: user },
            { href: "../work-other/c.md", source: user },
            { href: "/tmp/attach/w1/c1/1/copy.md", source: user },
            { href: "notes.md", source: user },
          ],
        }),
      ).toEqual({
        candidates: [[`${ROOT}/docs/b.md`], null, ["/tmp/attach/w1/c1/1/copy.md"], null],
      });
    } finally {
      open.mockRestore();
      stopWatchingChatSources();
    }
  });

  test("the chat.sourcesPresent op answers no for every source of a tab that is gone", async () => {
    const asked = { workspaceId: "w1", tabId: "c1", sources: [{ kind: "answer", itemKey: "a1" }] };
    expect(await chatHandlers["chat.sourcesPresent"](asked as never)).toEqual({ present: [true] });
    useTabsStore.setState({ byWorkspace: { w1: {} } } as never);
    expect(await chatHandlers["chat.sourcesPresent"](asked as never)).toEqual({ present: [false] });
  });

  test("a chat losing items, or its tab closing, tells main once", async () => {
    watchChatSources();
    told.length = 0;
    const chat = useChatStore.getState().tabs[chatKey("w1", "c1")];
    useChatStore.setState({
      tabs: {
        [chatKey("w1", "c1")]: { ...chat, model: { ...chat.model, items: [...chat.model.items] } },
      },
    } as never);
    await Promise.resolve();
    expect(told).toEqual([]);
    useChatStore.setState({
      tabs: { [chatKey("w1", "c1")]: { ...chat, model: { ...chat.model, items: [] } } },
    } as never);
    useTabsStore.setState({ byWorkspace: { w1: {} } } as never);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(told).toEqual([{ workspaceId: "w1", tabId: "c1" }]);
  });
});

describe("the files another device may read outside the workspace", () => {
  test("standing has what tools finished with and answers' images; an agent's leaves out reads", async () => {
    const { files, standing, agent } = await chatHandlers["chat.outsideFiles"]({
      workspaceId: "w1",
    } as never);
    expect(standing).toContain("/tmp/out/made.txt");
    expect(standing).toContain("/tmp/looked/secret.txt");
    expect(standing).toContain("/tmp/out/chart.png");
    expect(standing).toContain("/tmp/j.out");
    expect(agent).toContain("/tmp/out/made.txt");
    expect(agent).toContain("/tmp/j.out");
    expect(agent).not.toContain("/tmp/looked/secret.txt");
    expect(agent).not.toContain("/tmp/out/chart.png");
    expect(files).toContain("/tmp/looked/secret.txt");
  });
});
