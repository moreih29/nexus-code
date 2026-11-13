/**
 * nexus chat ... --device and tab close --device: another computer's
 * Claude and Codex tabs, read and driven through the remote's room, the
 * output as the local commands print it.
 */
import { describe, expect, test } from "bun:test";
import type { RemoteSession } from "../../../../packages/remote-protocol/src";
import { CLI_COMMANDS } from "../../../../src/main/features/cli/commands";
import type { CliDevice } from "../../../../src/main/features/cli/context";
import { runCli } from "../../../../src/main/features/cli/registry";
import { APP, CLAUDE_TAB, contextFor, type FakeApp, fakeApp, SHELL_TAB } from "./fake-services";

const NOW = 1_700_000_000_000;
const SELF = "3f2a91c0-0000-4000-8000-000000000001";
const MINI = "9b1e44d2-0000-4000-8000-000000000002";
const SITE = "dddddddd-0000-4000-8000-0000000000aa";
const REVIEW = "1a2b3c4d-0000-4000-8000-0000000000bb";
const TERM = "5e6f7a8b-0000-4000-8000-0000000000cc";

const SESSIONS: RemoteSession[] = [
  {
    workspaceId: SITE,
    tabId: REVIEW,
    kind: "claude",
    title: "Review",
    state: "idle",
    since: NOW - 60_000,
  },
  {
    workspaceId: SITE,
    tabId: TERM,
    kind: "terminal",
    title: "claude",
    state: "needs-you",
    waiting: { kind: "permission", text: "Bash npm test", requestId: "ask-1" },
  },
];

const STATUS = {
  agent: "claude",
  title: "Review",
  running: false,
  process: "running",
  turn: null,
  streaming: null,
  permissions: [] as unknown[],
};

type Handler = (params: Record<string, unknown>) => unknown;

/** "MacBook" with "Mac mini" online, taking agents' requests; `handlers` answer its methods. */
function withPeer(handlers: Record<string, Handler> = {}): FakeApp {
  const app = fakeApp(NOW);
  const device = (over: Partial<CliDevice> & Pick<CliDevice, "id" | "name">): CliDevice => ({
    platform: "macos",
    self: false,
    online: true,
    serves: [],
    ...over,
  });
  app.peers.devices = [
    device({ id: SELF, name: "MacBook", self: true }),
    device({
      id: MINI,
      name: "Mac mini",
      serves: ["sessions", "chat.read", "agents"],
      schema: "0.2.0",
    }),
  ];
  const all: Record<string, Handler> = {
    "sessions.list": () => ({
      workspaces: [{ id: SITE, name: "site", path: "/Users/me/site" }],
      sessions: SESSIONS,
    }),
    ...handlers,
  };
  app.peers.answer = async (_d, method, params) => {
    const handler = all[method];
    if (!handler) throw new Error(`no answer for ${method}`);
    return handler(params as Record<string, unknown>);
  };
  return app;
}

const AGENT = { workspaceId: APP, tabId: CLAUDE_TAB };
const USER = { workspaceId: APP, tabId: SHELL_TAB };

async function nexus(app: FakeApp, argv: string[], caller = USER, stdin?: string) {
  return runCli(CLI_COMMANDS, contextFor(app, argv, caller, stdin === undefined ? {} : { stdin }));
}

function asked(app: FakeApp, method: string) {
  return app.peers.requests.filter((r) => r.method === method).map((r) => r.params);
}

describe("chat send --device", () => {
  test("an agent's message goes as its own, and --wait waits on the other computer after it", async () => {
    let waits = 0;
    const app = withPeer({
      "chat.send": () => ({ at: NOW + 5 }),
      "chat.wait": () =>
        ++waits < 3
          ? { done: false, state: "working" }
          : { done: true, state: "idle", message: "All good." },
    });
    const result = await nexus(
      app,
      ["chat", "send", "Review", "--device", "Mac mini", "--wait", "-"],
      AGENT,
      "Run the tests\n",
    );
    expect(result.stdout).toBe(
      'Sent to Review (1a2b3c4d) on "Mac mini".\nClaude in Review finished:\nAll good.\n',
    );
    expect(result.exitCode).toBe(0);
    expect(asked(app, "chat.send")).toEqual([
      {
        workspaceId: SITE,
        tabId: REVIEW,
        text: "Run the tests",
        from: {
          kind: "terminal",
          agent: "claude",
          workspaceId: APP,
          tabId: CLAUDE_TAB,
          name: expect.any(String),
          hops: 1,
        },
      },
    ]);
    expect(asked(app, "chat.wait")[0]).toEqual({
      workspaceId: SITE,
      tabId: REVIEW,
      timeoutMs: 10_000,
      after: NOW + 5,
    });
  });

  test("the user's own message goes as theirs; JSON names the computer", async () => {
    const app = withPeer({ "chat.send": () => ({ at: NOW }) });
    const result = await nexus(app, ["chat", "send", "1a2b", "--device", MINI, "hi", "--json"]);
    expect(JSON.parse(result.stdout)).toEqual({
      tabId: REVIEW,
      workspaceId: SITE,
      device: { id: MINI, name: "Mac mini" },
      text: "hi",
    });
    expect(asked(app, "chat.send")[0]).not.toHaveProperty("from");
  });

  test("a tab is found among the computer's, in --workspace when given; . is this computer's", async () => {
    const app = withPeer();
    expect((await nexus(app, ["chat", "send", "Nope", "--device", "Mac mini", "x"])).stderr).toBe(
      'nexus: no Claude or Codex tab on "Mac mini" "Nope"\n',
    );
    const dot = await nexus(app, ["chat", "send", ".", "--device", "Mac mini", "x"]);
    expect(dot.exitCode).toBe(2);
    const ws = await nexus(app, [
      "chat",
      "send",
      "Review",
      "--workspace",
      "api",
      "--device",
      "Mac mini",
      "x",
    ]);
    expect(ws.stderr).toBe('nexus: no workspace on "Mac mini" "api"\n');
  });
});

describe("chat wait --device", () => {
  test("the computer going away ends the wait as offline, exit 3", async () => {
    const app = withPeer({
      "chat.wait": () => {
        throw Object.assign(new Error("that device is not in the room"), { code: 1003 });
      },
    });
    const result = await nexus(app, ["chat", "wait", "Review", "--device", "Mac mini", "--json"]);
    expect(result.exitCode).toBe(3);
    expect(JSON.parse(result.stdout)).toMatchObject({ tabId: REVIEW, state: "offline" });
  });

  test("a wait that runs out exits 124", async () => {
    const app = withPeer({ "chat.wait": () => ({ done: false, state: "working" }) });
    const result = await nexus(app, [
      "chat",
      "wait",
      "Review",
      "--device",
      "Mac mini",
      "--timeout",
      "5s",
    ]);
    expect(result.exitCode).toBe(124);
    expect(result.stdout).toContain("Review was still working when the wait ran out");
  });

  test("a closed tab is done", async () => {
    const app = withPeer({ "chat.wait": () => ({ done: true, state: "closed" }) });
    const result = await nexus(app, ["chat", "wait", "Review", "--device", "Mac mini"]);
    expect(result.stdout).toBe("Review was closed.\n");
  });
});

describe("chat read --device", () => {
  const page = (start: number, texts: string[]) => ({
    status: STATUS,
    start,
    total: 30,
    items: texts.map((text, k) => ({
      kind: k % 2 === 0 ? "user" : "assistant",
      key: `k${start + k}`,
      ...(k % 2 === 0
        ? { text, images: [], state: "taken" }
        : { messageId: `m${k}`, blocks: [{ type: "text", text }] }),
    })),
    tools: {},
    tasks: {},
    agentItems: {},
  });

  test("tells the page as chat read does, with where it stands and the computer in JSON", async () => {
    const app = withPeer({
      "chat.read": () => page(28, ["Review it", "Looks fine."]),
      "chat.wait": () => ({ done: true, state: "idle", message: "Looks fine." }),
    });
    const result = await nexus(app, ["chat", "read", "Review", "--device", "Mac mini"]);
    expect(result.stdout).toBe(
      "── user #28\nReview it\n── claude #29\nLooks fine.\n\nClaude in Review is idle.\n",
    );
    expect(asked(app, "chat.read")[0]).toEqual({ workspaceId: SITE, tabId: REVIEW, limit: 20 });
    const json = JSON.parse(
      (await nexus(app, ["chat", "read", "Review", "--device", "Mac mini", "--json"])).stdout,
    );
    expect(json).toMatchObject({
      tabId: REVIEW,
      workspaceId: SITE,
      device: { id: MINI, name: "Mac mini" },
      agent: "claude",
      state: "idle",
      since: NOW - 60_000,
      last: 29,
    });
  });

  test("--since reads back a page at a time to after #I", async () => {
    const app = withPeer({
      "chat.read": (params) =>
        params.before === undefined
          ? page(26, ["c", "d", "e", "f"])
          : page(22, ["a", "b", "x", "y"]),
      "chat.wait": () => ({ done: false, state: "working" }),
    });
    const result = await nexus(app, [
      "chat",
      "read",
      "Review",
      "--device",
      "Mac mini",
      "--since",
      "23",
      "--jsonl",
    ]);
    const lines = result.stdout
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(lines.slice(0, -1).map((e) => e.i)).toEqual([24, 25, 26, 27, 28, 29]);
    expect(lines.at(-1)).toMatchObject({ state: "working" });
    expect(asked(app, "chat.read")).toEqual([
      { workspaceId: SITE, tabId: REVIEW, limit: 500 },
      { workspaceId: SITE, tabId: REVIEW, before: 26, limit: 500 },
    ]);
  });
});

describe("chat new --device", () => {
  test("opens a tab in a workspace there, sending the prompt as the agent's", async () => {
    const app = withPeer({ "chat.new": () => ({ tabId: "77777777-0000-4000-8000-000000000077" }) });
    const result = await nexus(
      app,
      [
        "chat",
        "new",
        "--device",
        "Mac mini",
        "--workspace",
        "site",
        "--prompt",
        "Fix it",
        "--model",
        "haiku",
        "--mode",
        "plan",
      ],
      AGENT,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(
      'Opened Claude tab 77777777 in /Users/me/site on "Mac mini" and sent it the prompt. To wait for it:\n' +
        "  nexus chat wait 77777777 --workspace dddddddd --device 9b1e44d2\n",
    );
    expect(asked(app, "chat.new")[0]).toMatchObject({
      workspaceId: SITE,
      agent: "claude",
      prompt: "Fix it",
      model: "haiku",
      permissionMode: "plan",
      from: { kind: "terminal", hops: 1 },
    });
  });

  test("needs --workspace, and --show is this computer's", async () => {
    const app = withPeer();
    expect((await nexus(app, ["chat", "new", "--device", "Mac mini"])).stderr).toBe(
      `nexus: give --workspace: which of "Mac mini"'s workspaces\n`,
    );
    expect(
      (await nexus(app, ["chat", "new", "--device", "Mac mini", "--workspace", "site", "--show"]))
        .stderr,
    ).toContain("--show is for this computer's tabs");
  });
});

describe("chat answer --device", () => {
  test("answers the request a chat waits on there, by its id", async () => {
    const app = withPeer({
      "chat.read": () => ({
        status: { ...STATUS, permissions: [{ requestId: "req-9", toolName: "Bash", input: {} }] },
        start: 0,
        total: 0,
        items: [],
        tools: {},
        tasks: {},
        agentItems: {},
      }),
      "chat.answer": () => ({}),
    });
    const result = await nexus(
      app,
      ["chat", "answer", "Review", "deny", "--device", "Mac mini", "--message", "not now"],
      AGENT,
    );
    expect(result.stdout).toBe('Denied Bash in Review (1a2b3c4d) on "Mac mini".\n');
    expect(asked(app, "chat.answer")[0]).toMatchObject({
      requestId: "req-9",
      decision: "deny",
      message: "not now",
      from: { kind: "terminal" },
    });
  });

  test("a terminal's Claude Code there is answered by its request's id", async () => {
    const app = withPeer({ "terminal.answer": () => ({}) });
    const result = await nexus(app, ["chat", "answer", "5e6f", "allow", "--device", "Mac mini"]);
    expect(result.stdout).toBe('Allowed Bash npm test in claude (5e6f7a8b) on "Mac mini".\n');
    expect(asked(app, "terminal.answer")[0]).toEqual({
      workspaceId: SITE,
      tabId: TERM,
      requestId: "ask-1",
      decision: "allow",
    });
  });

  test("a question is the user's to answer", async () => {
    const app = withPeer({
      "chat.read": () => ({
        status: {
          ...STATUS,
          permissions: [{ requestId: "q", toolName: "AskUserQuestion", input: {} }],
        },
        start: 0,
        total: 0,
        items: [],
        tools: {},
        tasks: {},
        agentItems: {},
      }),
    });
    const result = await nexus(app, ["chat", "answer", "Review", "allow", "--device", "Mac mini"]);
    expect(result.stderr).toBe(
      "nexus: Review asks the user a question; that is the user's to answer in the app\n",
    );
    expect(asked(app, "chat.answer")).toEqual([]);
  });
});

describe("chat interrupt, set and tab close --device", () => {
  test("interrupt stops the turn there", async () => {
    const app = withPeer({ "chat.interrupt": () => ({}) });
    const result = await nexus(app, ["chat", "interrupt", "Review", "--device", "Mac mini"]);
    expect(result.stdout).toBe('Stopped the turn of Review (1a2b3c4d) on "Mac mini".\n');
  });

  const settings = (mode: string) => ({
    agent: "claude",
    model: "haiku",
    effort: null,
    permissionMode: mode,
    options: {
      models: [{ id: "haiku", label: "Haiku" }],
      efforts: [],
      modes: [{ id: "default", label: "Default" }],
    },
  });

  test("set lists what the tab runs with, and sets the mode as the agent's request", async () => {
    const app = withPeer({
      "chat.settings": () => settings("default"),
      "chat.configure": (params) => settings(String(params.permissionMode)),
    });
    const listed = await nexus(app, ["chat", "set", "Review", "--device", "Mac mini"]);
    expect(listed.stdout).toStartWith('Claude in Review on "Mac mini":\n  model   haiku\n');
    const set = await nexus(
      app,
      ["chat", "set", "Review", "--device", "Mac mini", "--mode", "plan"],
      AGENT,
    );
    expect(set.stdout).toBe(
      'Review (1a2b3c4d) on "Mac mini" now runs with model haiku, effort (the model\'s default), mode plan.\n',
    );
    expect(asked(app, "chat.configure")[0]).toMatchObject({
      permissionMode: "plan",
      from: { hops: 1 },
    });
    expect(
      (await nexus(app, ["chat", "set", "Review", "--device", "Mac mini", "--profile", "Work"]))
        .stderr,
    ).toContain("--profile is for this computer's tabs");
  });

  test("tab close closes a terminal there, a running one with --force", async () => {
    const app = withPeer({ "terminal.close": () => ({}), "chat.close": () => ({}) });
    expect(
      (await nexus(app, ["tab", "close", "5e6f", "--device", "Mac mini", "--force"])).stdout,
    ).toBe('Closed claude (5e6f7a8b) on "Mac mini".\n');
    expect(asked(app, "terminal.close")[0]).toEqual({
      workspaceId: SITE,
      tabId: TERM,
      force: true,
    });
    await nexus(app, ["tab", "close", "Review", "--device", "Mac mini"]);
    expect(asked(app, "chat.close")).toEqual([{ workspaceId: SITE, tabId: REVIEW }]);
    expect((await nexus(app, ["tab", "close", "--all", "--device", "Mac mini"])).exitCode).toBe(2);
  });
});
