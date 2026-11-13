/** What this device serves the others: its sessions, as the CLI's services see them. */
import { describe, expect, test } from "bun:test";
import type { CliServices } from "../../../../../src/main/features/cli/context";
import { listSessions, servesWith, serveWith } from "../../../../../src/main/features/remote/serve";
import { MANAGER_WORKSPACE_ID } from "../../../../../src/shared/manager/manager";

function services(): CliServices {
  const workspaces = [
    { id: "w1", name: "app", rootPath: "/src/app" },
    { id: "w2", name: "feat", rootPath: "/src/app-feat", task: { parentId: "w1", branch: "feat" } },
    { id: "w3", name: "closed", rootPath: "/src/closed" },
  ];
  const tabs: Record<string, { id: string; type: string; title: string }[]> = {
    w1: [
      { id: "t1", type: "claude", title: "Fix the build" },
      { id: "t2", type: "terminal", title: "zsh" },
      { id: "t3", type: "editor", title: "a.ts" },
    ],
    w2: [{ id: "t4", type: "codex", title: "Review" }],
    [MANAGER_WORKSPACE_ID]: [],
  };
  return {
    listWorkspaces: () => workspaces,
    managerWorkspace: () => ({ id: MANAGER_WORKSPACE_ID, name: "Manager", rootPath: "/manager" }),
    claudeAsks: (_w: string, tab: string) =>
      tab === "t2" ? [{ id: "h1", tool: "Bash", target: "rm -rf dist", always: [], since: 5 }] : [],
    claudeStatus: (_w: string, tab: string) =>
      tab === "t2" ? { status: "permissionPending", message: "Allow rm?", since: 5 } : null,
    activity: () => null,
    ui: async (op: string, args: { workspaceId: string; tabId?: string }) => {
      if (op === "tabs.list") {
        const list = tabs[args.workspaceId];
        if (!list) throw new Error("not open");
        return { tabs: list };
      }
      if (args.tabId === "t1") {
        return {
          agent: "claude",
          state: "asking",
          message: "May I run\n  bun test?",
          since: 10,
          profile: "work",
          request: { id: "r1", tool: "Bash", input: "bun test" },
          waiting: { kind: "permission", text: "Bash bun\ntest" },
        };
      }
      return { agent: "codex", state: "working", since: 20 };
    },
  } as unknown as CliServices;
}

describe("serving the sessions", () => {
  test("lists the chats and terminals of every workspace, in the app's order", async () => {
    const git = (w: { id: string }) =>
      w.id === "w2" ? { branch: "feat", ahead: 2, behind: 0, uncommitted: 3 } : undefined;
    const list = await listSessions(services(), git);
    expect(list.workspaces.map((w) => w.id)).toEqual(["w1", "w2", "w3", MANAGER_WORKSPACE_ID]);
    expect(list.workspaces[0]).toEqual({ id: "w1", name: "app", path: "/src/app" });
    // A task names its parent and how its branch stands; the manager's says it is the manager's.
    expect(list.workspaces[1]).toMatchObject({
      parentId: "w1",
      git: { branch: "feat", ahead: 2, behind: 0, uncommitted: 3 },
    });
    expect(list.workspaces[3]).toMatchObject({ manager: true });
    expect(list.sessions).toEqual([
      {
        workspaceId: "w1",
        tabId: "t1",
        kind: "claude",
        title: "Fix the build",
        state: "needs-you",
        since: 10,
        last: "May I run bun test?",
        profile: "work",
        waiting: { kind: "permission", text: "Bash bun test" },
      },
      {
        workspaceId: "w1",
        tabId: "t2",
        kind: "terminal",
        title: "zsh",
        state: "needs-you",
        since: 5,
        last: "Allow rm?",
        // What the terminal's Claude Code asks, as the app holds it.
        waiting: { kind: "permission", text: "Bash rm -rf dist", requestId: "h1" },
      },
      {
        workspaceId: "w2",
        tabId: "t4",
        kind: "codex",
        title: "Review",
        state: "running",
        since: 20,
      },
    ]);
  });

  test("is unavailable until the app made its services, and serves nothing else yet", async () => {
    await expect(
      serveWith(() => null)({ from: "d", method: "sessions.list", params: {} }),
    ).rejects.toMatchObject({ code: 1003 });
    await expect(
      serveWith(services)({ from: "d", method: "chat.watch", params: {} }),
    ).rejects.toMatchObject({ code: -32601 });
  });
});

describe("serving a chat and a terminal to read", () => {
  /** The services, recording the UI requests other than the tabs' list. */
  function recording(answer: (op: string) => unknown = () => ({ text: "$ ls" })) {
    const asked: [string, unknown][] = [];
    const base = services();
    const s = {
      ...base,
      ui: async (op: string, args: { workspaceId: string; tabId?: string }) => {
        if (op === "tabs.list") return base.ui("tabs.list", args as { workspaceId: string });
        asked.push([op, args]);
        const a = answer(op);
        if (a instanceof Error) throw a;
        return a;
      },
    } as unknown as CliServices;
    return { s, asked };
  }

  test("reads a chat's page from the app, as asked", async () => {
    const { s, asked } = recording(() => ({ start: 0, total: 0, items: [] }));
    await serveWith(() => s)({
      from: "d",
      method: "chat.read",
      params: { workspaceId: "w1", tabId: "t1", before: 40, limit: 20 },
    });
    expect(asked).toEqual([
      ["chat.page", { workspaceId: "w1", tabId: "t1", before: 40, limit: 20 }],
    ]);
  });

  test("reads a terminal's last 1000 lines unless told", async () => {
    const { s, asked } = recording();
    const read = (params: object) =>
      serveWith(() => s)({ from: "d", method: "terminal.read", params });
    expect(await read({ workspaceId: "w1", tabId: "t2" })).toEqual({ text: "$ ls" });
    await read({ workspaceId: "w1", tabId: "t2", lines: 50 });
    expect(asked.map(([, a]) => (a as { lines: number }).lines)).toEqual([1000, 50]);
  });

  test("a tab that is not there, or not of that kind, is not found", async () => {
    const { s, asked } = recording();
    const serve = serveWith(() => s);
    for (const params of [
      { workspaceId: "nope", tabId: "t1" },
      { workspaceId: "w1", tabId: "nope" },
      { workspaceId: "w1", tabId: "t3" },
      { workspaceId: "w3", tabId: "t1" },
    ]) {
      await expect(serve({ from: "d", method: "chat.read", params })).rejects.toMatchObject({
        code: 1001,
      });
    }
    await expect(
      serve({ from: "d", method: "terminal.read", params: { workspaceId: "w1", tabId: "t1" } }),
    ).rejects.toMatchObject({ code: 1001 });
    expect(asked).toEqual([]);
  });

  test("the app failing to read it is unavailable, saying why", async () => {
    const { s } = recording(() => new Error("that tab is gone"));
    await expect(
      serveWith(() => s)({
        from: "d",
        method: "chat.read",
        params: { workspaceId: "w1", tabId: "t1" },
      }),
    ).rejects.toMatchObject({ code: 1003, message: "that tab is gone" });
  });
});

describe("what this device serves", () => {
  test("its chats' controls only when the user allows them", () => {
    expect(servesWith(true)).toContain("chat.control");
    expect(servesWith(false)).not.toContain("chat.control");
    expect(servesWith(false)).toContain("chat.read");
  });
});

describe("serving a chat's controls", () => {
  function recording(fail?: string) {
    const asked: [string, unknown][] = [];
    const base = services();
    const s = {
      ...base,
      ui: async (op: string, args: { workspaceId: string }) => {
        if (op === "tabs.list") return base.ui("tabs.list", args);
        asked.push([op, args]);
        if (fail) throw new Error(fail);
        return op === "chat.open" ? { tabId: "t9" } : {};
      },
    } as unknown as CliServices;
    return { serve: serveWith(() => s), asked };
  }
  const tab = { workspaceId: "w1", tabId: "t1" };

  test("sends as the user, who may write while the chat asks", async () => {
    const { serve, asked } = recording();
    await serve({ from: "d", method: "chat.send", params: { ...tab, text: "go on" } });
    expect(asked).toEqual([["chat.send", { ...tab, text: "go on", user: true }]]);
  });

  test("answers the request it names, with a question's answers or a stop", async () => {
    const { serve, asked } = recording();
    await serve({
      from: "d",
      method: "chat.answer",
      params: { ...tab, requestId: "r1", decision: "allow", updatedInput: { answers: { q: "a" } } },
    });
    await serve({
      from: "d",
      method: "chat.answer",
      params: { ...tab, requestId: "r2", decision: "deny", message: "no", stop: true },
    });
    expect(asked).toEqual([
      [
        "chat.answer",
        { ...tab, decision: "allow", expect: "r1", updatedInput: { answers: { q: "a" } } },
      ],
      ["chat.answer", { ...tab, decision: "deny", expect: "r2", message: "no", stop: true }],
    ]);
  });

  test("opens a chat in the workspace's folder, behind what this computer shows", async () => {
    const { serve, asked } = recording();
    const opened = await serve({
      from: "d",
      method: "chat.new",
      params: { workspaceId: "w2", agent: "codex", prompt: "review" },
    });
    expect(opened).toEqual({ tabId: "t9" });
    expect(asked).toEqual([
      [
        "chat.open",
        {
          workspaceId: "w2",
          agent: "codex",
          cwd: "/src/app-feat",
          prompt: "review",
          placement: { background: true },
        },
      ],
    ]);
  });

  test("opens a chat with the model and effort asked, saying when they could not be set", async () => {
    const asked: [string, unknown][] = [];
    const base = services();
    const s = {
      ...base,
      ui: async (op: string, args: { workspaceId: string }) => {
        asked.push([op, args]);
        return { tabId: "t9", error: 'claude has no model "gpt"' };
      },
    } as unknown as CliServices;
    const opened = await serveWith(() => s)({
      from: "d",
      method: "chat.new",
      params: { workspaceId: "w2", agent: "claude", prompt: "hi", model: "haiku", effort: "low" },
    });
    expect(opened).toEqual({ tabId: "t9", error: 'claude has no model "gpt"' });
    expect(asked[0]?.[1]).toMatchObject({ settings: { model: "haiku", effort: "low" } });
  });

  test("stops and closes only a chat; the app refusing is unavailable", async () => {
    const { serve, asked } = recording();
    await serve({ from: "d", method: "chat.interrupt", params: tab });
    await serve({ from: "d", method: "chat.close", params: tab });
    expect(asked).toEqual([
      ["chat.interrupt", tab],
      ["tab.close", { ...tab, force: false }],
    ]);
    await expect(
      serve({ from: "d", method: "chat.close", params: { workspaceId: "w1", tabId: "t2" } }),
    ).rejects.toMatchObject({ code: 1001 });
    await expect(
      recording("it has no turn to stop").serve({
        from: "d",
        method: "chat.interrupt",
        params: tab,
      }),
    ).rejects.toMatchObject({ code: 1003, message: "it has no turn to stop" });
  });
});

describe("serving what goes in a frame", () => {
  test("a chat page too large for a frame is read again with fewer items", async () => {
    const limits: number[] = [];
    const base = services();
    const big = "x".repeat(150_000);
    const s = {
      ...base,
      ui: async (op: string, args: { workspaceId: string; limit?: number }) => {
        if (op === "tabs.list") return base.ui("tabs.list", args);
        const n = args.limit ?? 0;
        limits.push(n);
        return {
          start: 0,
          total: n,
          items: Array.from({ length: n }, (_, i) => ({
            kind: "shell",
            key: `k${i}`,
            command: big,
          })),
        };
      },
    } as unknown as CliServices;
    const page = (await serveWith(() => s)({
      from: "d",
      method: "chat.read",
      params: { workspaceId: "w1", tabId: "t1", limit: 20 },
    })) as { items: unknown[] };
    expect(limits).toEqual([20, 10, 5]);
    expect(page.items).toHaveLength(5);
  });

  test("a terminal's text too large for a frame keeps its end", async () => {
    const base = services();
    const text = `${"a".repeat(2_000_000)}THE END`;
    const s = {
      ...base,
      ui: async (op: string, args: { workspaceId: string }) =>
        op === "tabs.list" ? base.ui("tabs.list", args) : { text },
    } as unknown as CliServices;
    const read = (await serveWith(() => s)({
      from: "d",
      method: "terminal.read",
      params: { workspaceId: "w1", tabId: "t2" },
    })) as { text: string };
    expect(read.text.endsWith("THE END")).toBe(true);
    expect(read.text.length).toBeLessThan(800_000);
  });
});
