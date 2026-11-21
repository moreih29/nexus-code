/**
 * nexus chat ... --device and tab close --device: another computer's
 * Claude and Codex tabs, read and driven through the remote's room, the
 * output as the local commands print it.
 */
import { describe, expect, test } from "bun:test";
import type { RemoteSession } from "../../../../packages/remote-protocol/src";
import { CLI_COMMANDS } from "../../../../src/main/features/cli/commands";
import type { CliCaller, CliDevice } from "../../../../src/main/features/cli/context";
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

function enablePeerCli(app: FakeApp) {
  app.peers.devices = app.peers.devices.map((peer) =>
    peer.id === MINI ? { ...peer, serves: [...peer.serves, "agents.cli"] } : peer,
  );
}
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
/** What the user runs at a shell goes there as an agent in that terminal: it is not told from one. */
const FROM_SHELL = { kind: "terminal", ...USER };

function unrestrictedCaller(app: FakeApp): CliCaller {
  app.tabs[APP] = (app.tabs[APP] ?? []).map((tab) =>
    tab.id === CLAUDE_TAB ? { ...tab, type: "claude" } : tab,
  );
  app.uiAnswers.set("chat.mode", { agent: "claude", mode: "bypassPermissions" });
  return { ...AGENT, verified: true };
}

async function nexus(app: FakeApp, argv: string[], caller: CliCaller = USER, stdin?: string) {
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
          waits: true,
        },
      },
    ]);
    expect(asked(app, "chat.wait")[0]).toEqual({
      workspaceId: SITE,
      tabId: REVIEW,
      timeoutMs: 10_000,
      after: NOW + 5,
      from: expect.objectContaining({ agent: "claude", tabId: CLAUDE_TAB }),
    });
  });

  test("the user's own message goes as an agent's in their terminal; JSON names the computer", async () => {
    const app = withPeer({ "chat.send": () => ({ at: NOW }) });
    const result = await nexus(app, ["chat", "send", "1a2b", "--device", MINI, "hi", "--json"]);
    expect(JSON.parse(result.stdout)).toEqual({
      tabId: REVIEW,
      workspaceId: SITE,
      device: { id: MINI, name: "Mac mini" },
      text: "hi",
    });
    // Sent without --wait: the agent there is told to write back.
    expect(asked(app, "chat.send")[0]).toMatchObject({ from: { ...FROM_SHELL, waits: false } });
  });

  test("--now works across versions; --after needs a compatible peer", async () => {
    const app = withPeer({ "chat.send": () => ({ at: NOW }) });
    const now = await nexus(app, ["chat", "send", "Review", "--device", "Mac mini", "--now", "hi"]);
    expect(now.exitCode).toBe(0);
    expect(asked(app, "chat.send")).toEqual([expect.objectContaining({ text: "hi", when: "now" })]);
    const after = await nexus(app, [
      "chat",
      "send",
      "Review",
      "--device",
      "Mac mini",
      "--after",
      "x",
    ]);
    expect(after.exitCode).toBe(3);
    expect(after.stderr).toContain("Update NexusCode");
    expect(asked(app, "chat.send")).toHaveLength(1);
    expect(asked(app, "sessions.list")).toHaveLength(1);
    const peer = app.peers.devices[1]!;
    app.peers.devices[1] = { ...peer, serves: [...peer.serves, "agents.cli"] };
    const queued = await nexus(app, [
      "chat",
      "send",
      "Review",
      "--device",
      MINI,
      "--after",
      "later",
    ]);
    expect(queued.exitCode).toBe(0);
    expect(asked(app, "chat.send")[1]).toMatchObject({
      when: "after",
      text: "later",
      from: FROM_SHELL,
    });
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

  test("checks an already finished tab immediately alongside a busy tab", async () => {
    const finished = "6a2b3c4d-0000-4000-8000-0000000000cc";
    const app = withPeer({
      "sessions.list": () => ({
        workspaces: [{ id: SITE, name: "site", path: "/site" }],
        sessions: [
          ...SESSIONS,
          { workspaceId: SITE, tabId: finished, kind: "codex", title: "Finished", state: "idle" },
        ],
      }),
      "chat.wait": async ({ tabId, timeoutMs }) => {
        if (tabId === finished) return { done: true, state: "idle", message: "Already done." };
        await app.services.clock.sleep(Number(timeoutMs));
        return { done: false, state: "working" };
      },
    });
    const result = await nexus(app, [
      "chat",
      "wait",
      "Review",
      "Finished",
      "--device",
      "Mac mini",
      "--timeout",
      "1s",
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Already done.");
    expect(asked(app, "chat.wait")).toMatchObject([
      { tabId: REVIEW, timeoutMs: 1 },
      { tabId: finished, timeoutMs: 1 },
    ]);
    expect(app.time.now).toBe(NOW + 1);
  });

  test("the command deadline cancels an outstanding wait request", async () => {
    const app = withPeer();
    const answer = app.peers.answer;
    app.peers.answer = (device, method, params, signal) => {
      if (method !== "chat.wait") return answer(device, method, params, signal);
      if (!signal) throw new Error("chat.wait needs a cancellation signal");
      return new Promise((_, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    };
    const result = await nexus(app, [
      "chat",
      "wait",
      "Review",
      "--device",
      "Mac mini",
      "--timeout",
      "20ms",
    ]);
    expect(result.exitCode).toBe(124);
    expect(asked(app, "chat.wait")).toHaveLength(1);
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
      "chat.read": ({ before }) =>
        before === undefined
          ? page(28, ["Review it", "Looks fine."])
          : { ...page(10, []), items: Array.from({ length: 18 }, () => ({ kind: "notice" })) },
      "chat.wait": () => ({ done: true, state: "idle", message: "Looks fine." }),
    });
    const result = await nexus(app, ["chat", "read", "Review", "--device", "Mac mini"]);
    expect(result.stdout).toBe(
      "── user #28\nReview it\n── claude #29\nLooks fine.\n\nClaude in Review is idle.\n",
    );
    expect(asked(app, "chat.read")[0]).toEqual({
      workspaceId: SITE,
      tabId: REVIEW,
      limit: 20,
      from: expect.any(Object),
    });
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
        params.before === undefined ? page(26, ["c", "d", "e", "f"]) : page(24, ["x", "y"]),
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
      { workspaceId: SITE, tabId: REVIEW, limit: 500, from: expect.any(Object) },
      { workspaceId: SITE, tabId: REVIEW, before: 26, limit: 2, from: expect.any(Object) },
    ]);
  });
  function withLongChat() {
    const total = 5200;
    return withPeer({
      "chat.read": ({ before, limit }) => {
        const stop = Number(before ?? total);
        const start = Math.max(0, stop - Number(limit));
        return {
          ...page(start, []),
          total,
          items: Array.from({ length: stop - start }, (_, i) => ({
            kind: "user",
            key: String(start + i),
            text: `Message ${start + i}`,
            images: [],
          })),
        };
      },
      "chat.wait": () => ({ done: true, state: "idle" }),
    });
  }

  test("reads more than one page for --messages", async () => {
    const app = withLongChat();
    const result = await nexus(app, [
      "chat",
      "read",
      "Review",
      "--device",
      "Mac mini",
      "--messages",
      "600",
      "--json",
    ]);
    expect(result.exitCode).toBe(0);
    const { entries, last, more } = JSON.parse(result.stdout);
    expect(entries.map((entry: { i: number }) => entry.i)).toEqual(
      Array.from({ length: 600 }, (_, i) => i + 4600),
    );
    expect(last).toBe(5199);
    expect(more).toBeUndefined();
  });

  test.each([
    [["--all"], 0],
    [["--since", "0"], 1],
    [["--messages", "5100"], 100],
  ] as const)("returns a resumable cursor at the read cap with %j", async (flags, first) => {
    const app = withLongChat();
    const command = ["chat", "read", "Review", "--device", "Mac mini"];
    const result = await nexus(app, [...command, ...flags, "--jsonl"]);
    expect(result.exitCode).toBe(0);
    const rows = result.stdout
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line));
    const last = first + 4999;
    expect(rows.at(-1)).toMatchObject({ more: true, last });
    expect(rows.slice(0, -1).map((entry) => entry.i)).toEqual(
      Array.from({ length: 5000 }, (_, i) => i + first),
    );

    const continued = await nexus(app, [...command, "--since", String(last), "--json"]);
    expect(continued.exitCode).toBe(0);
    const json = JSON.parse(continued.stdout);
    expect(json.last).toBe(5199);
    expect(json.entries.map((entry: { i: number }) => entry.i)).toEqual(
      Array.from({ length: 5199 - last }, (_, i) => last + 1 + i),
    );
    expect(json.more).toBeUndefined();
  });
});

describe("chat new --device", () => {
  test("opens a tab in a workspace there, sending the prompt as the agent's", async () => {
    const app = withPeer({ "chat.new": () => ({ tabId: "77777777-0000-4000-8000-000000000077" }) });
    const older = await nexus(app, [
      "chat",
      "new",
      "--device",
      MINI,
      "--workspace",
      "site",
      "--mode",
      "plan",
    ]);
    expect(older.stderr).toContain("Update NexusCode");
    expect(asked(app, "chat.new")).toEqual([]);
    enablePeerCli(app);
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
      from: { kind: "terminal" },
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

  test.each([
    ["new", "--workspace", "site"],
    ["set", "Review"],
  ])("refuses an unrestricted mode for remote chat %s even from an unrestricted local tab", async (...args) => {
    const app = withPeer();
    const result = await nexus(
      app,
      ["chat", ...args, "--device", "Mac mini", "--mode", "bypassPermissions"],
      unrestrictedCaller(app),
    );
    expect(result.stderr).toContain("only the user picks it");
    expect(asked(app, "chat.new")).toEqual([]);
    expect(asked(app, "chat.configure")).toEqual([]);
    expect(app.uiCalls.some((call) => call.op === "chat.mode")).toBe(false);
  });
});

describe("chat answer --device", () => {
  test("sends a verified unrestricted tab's answer to the other device as an agent request", async () => {
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
      unrestrictedCaller(app),
    );
    expect(result.stdout).toBe('Denied Bash in Review (1a2b3c4d) on "Mac mini".\n');
    expect(asked(app, "chat.answer")[0]).toMatchObject({
      requestId: "req-9",
      decision: "deny",
      message: "not now",
      from: { kind: "tab", agent: "claude" },
    });
    expect(app.uiCalls.some((call) => call.op === "chat.mode")).toBe(false);
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
      from: FROM_SHELL,
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
    const args = ["chat", "set", "Review", "--device", "Mac mini", "--mode", "plan"];
    const old = await nexus(app, args, AGENT);
    expect(old.stderr).toContain("Update NexusCode");
    expect(asked(app, "chat.configure")).toEqual([]);
    enablePeerCli(app);
    const set = await nexus(app, args, AGENT);
    expect(set.stdout).toBe(
      'Review (1a2b3c4d) on "Mac mini" now runs with model haiku, effort (the model\'s default), mode plan.\n',
    );
    expect(asked(app, "chat.configure")[0]).toMatchObject({
      permissionMode: "plan",
      from: expect.objectContaining({ kind: "terminal" }),
    });
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
      from: FROM_SHELL,
    });
    await nexus(app, ["tab", "close", "Review", "--device", "Mac mini"]);
    expect(asked(app, "chat.close")).toEqual([
      { workspaceId: SITE, tabId: REVIEW, from: FROM_SHELL },
    ]);
    expect((await nexus(app, ["tab", "close", "--all", "--device", "Mac mini"])).exitCode).toBe(2);
  });
});

describe("expanded peer CLI reads", () => {
  test("requires a compatible peer before discovery and forwards reads as the caller", async () => {
    const app = withPeer({
      "chat.instructions": () => ({ instructions: "Run the suite first." }),
      "notes.transcript": () => ({ id: "note-1", title: "화자 기록", recordings: [] }),
      "files.list": () => ({ path: "/w/site", entries: [{ name: "src", kind: "dir" }] }),
    });
    const command = ["chat", "instructions", "Review", "--show", "--device", MINI];
    const old = await nexus(app, command);
    expect(old.exitCode).toBe(3);
    expect(old.stderr).toContain('Update NexusCode on "Mac mini"');
    expect(app.peers.requests).toEqual([]);
    const peer = app.peers.devices[1]!;
    app.peers.devices[1] = { ...peer, serves: [...peer.serves, "agents.cli"], schema: "0.15.0" };

    expect((await nexus(app, command)).stdout).toBe("Run the suite first.\n");
    const note = await nexus(app, [
      "note",
      "transcript",
      "Planning",
      "--workspace",
      "site",
      "--device",
      MINI,
      "--json",
    ]);
    expect(JSON.parse(note.stdout)).toMatchObject({ id: "note-1", recordings: [] });
    expect(note.stdout).toContain("화자 기록");
    const folder = await nexus(app, [
      "file",
      "list",
      "--workspace",
      "site",
      "--device",
      MINI,
      "--json",
    ]);
    expect(JSON.parse(folder.stdout)).toMatchObject({ entries: [{ name: "src", kind: "dir" }] });
    for (const method of ["chat.instructions", "notes.transcript", "files.list"]) {
      expect(asked(app, method)).toEqual([
        expect.objectContaining({ workspaceId: SITE, from: FROM_SHELL }),
      ]);
    }
  });
});

test("a peer slash command still has its execution budget after approval", async () => {
  const app = withPeer({
    "chat.command": () => ({
      remoteControl: { enabled: true, url: "https://claude.ai/code/example" },
    }),
    "chat.send": () => ({ remoteControl: { enabled: false } }),
  });
  enablePeerCli(app);
  const command = await nexus(app, ["chat", "command", "Review", "rc", "--device", MINI]);
  const send = await nexus(app, ["chat", "send", "Review", "/remote-control", "--device", MINI]);
  expect(command.stdout).toContain("Turned Remote Control on");
  expect(send.stdout).toContain("Turned Remote Control off");
  for (const method of ["chat.command", "chat.send"]) {
    expect(
      app.peers.requests.find((item) => item.method === method)?.timeoutMs,
    ).toBeGreaterThanOrEqual(150_000);
  }
});

test("a timed-out peer mutation reports that application is unknown", async () => {
  const app = withPeer({
    "chat.command": () => {
      throw Object.assign(new Error("chat.command: no answer in time"), {
        code: 1003,
        data: { outcome: "unknown" },
      });
    },
  });
  enablePeerCli(app);
  const result = await nexus(app, ["chat", "command", "Review", "rc", "--device", MINI, "--json"]);
  expect(result.exitCode).toBe(3);
  expect(result.stderr).toContain("the change may have been applied");
  expect(JSON.parse(result.stdout)).toMatchObject({ error: "timeout", outcome: "unknown" });
});
