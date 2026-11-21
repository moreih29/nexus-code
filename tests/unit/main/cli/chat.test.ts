/**
 * nexus chat new, read, send and wait: the app's Claude and Codex tabs,
 * driven from a terminal as their composer drives them.
 */
import { describe, expect, test } from "bun:test";
import { CLI_COMMANDS } from "../../../../src/main/features/cli/commands";
import type { CliCaller } from "../../../../src/main/features/cli/context";
import { runCli } from "../../../../src/main/features/cli/registry";
import { senderOf } from "../../../../src/main/features/cli/sender";
import { INSTRUCTION_LIMIT } from "../../../../src/shared/chat/instructions";
import type { CliChatInfo, CliTabInfo } from "../../../../src/shared/cli/ui";
import type { ChatAgent } from "../../../../src/shared/sessions/task-agent";
import {
  API,
  APP,
  CLAUDE_TAB,
  contextFor,
  type FakeApp,
  fakeApp,
  NEW_TAB,
  READABLE,
  SHELL_TAB,
} from "./fake-services";

const CHAT_TAB = "eeeeeeee-0000-4000-8000-000000000008";
const DOCS_TAB = "ffffffff-0000-4000-8000-000000000009";
const CALLER_TAB = "13131313-0000-4000-8000-000000000010";

async function nexus(
  app: FakeApp,
  argv: string[],
  caller: CliCaller = { workspaceId: APP, tabId: SHELL_TAB },
  stdin?: string,
) {
  return runCli(CLI_COMMANDS, contextFor(app, argv, caller, stdin === undefined ? {} : { stdin }));
}

function uiArgs(app: FakeApp, op: string): unknown {
  return app.uiCalls.find((c) => c.op === op)?.args;
}

/** An app with a Claude tab "Fix the login" in "app", standing as `info` says. */
function withChat(info: Partial<CliChatInfo> = {}): FakeApp {
  const app = fakeApp();
  const chat: CliTabInfo = {
    id: CHAT_TAB,
    type: info.agent ?? "claude",
    title: "Fix the login",
    groupId: "g1",
    shown: false,
  };
  app.tabs[APP]?.push(chat);
  app.chats.set(CHAT_TAB, {
    info: { agent: "claude", state: "idle", ...info },
    entries: [
      { i: 0, role: "user", text: "Fix the login redirect" },
      { i: 1, role: "agent", text: "Looking at the router." },
      { i: 2, role: "tool", text: "Read src/router.ts", toolUseId: "toolu_1", status: "done" },
      { i: 3, role: "agent", text: "Fixed it: the redirect keeps the page." },
    ],
    tools: [
      {
        i: 2,
        toolUseId: "toolu_1",
        name: "Read",
        status: "done",
        input: { file_path: "/w/app/src/router.ts" },
        result: { text: "export const routes = [];", isError: false },
      },
    ],
  });
  return app;
}

describe("chat read", () => {
  test("--since past the end says the conversation was cleared or rewound, and reads its start", async () => {
    const app = withChat();
    const result = await nexus(app, ["chat", "read", "eeee", "--since", "9"]);
    expect(result.stdout).toStartWith(
      "The conversation was cleared or rewound: it ends before #9 now. From its start:\n" +
        "── user #0\nFix the login redirect\n",
    );
    const json = JSON.parse(
      (await nexus(app, ["chat", "read", "eeee", "--since", "9", "--json"])).stdout,
    );
    expect(json.restarted).toBe(true);
    expect(json.entries.map((e: { i: number }) => e.i)).toEqual([0, 1, 2, 3]);
    expect(json.last).toBe(3);
  });
});

describe("chat send", () => {
  test("refuses an empty message, and asks before sending to another workspace's tab", async () => {
    const app = withChat();
    expect((await nexus(app, ["chat", "send", "eeee", " "])).stderr).toContain("nothing to send");
    const api = withChat();
    const chat = api.tabs[APP]?.pop() as CliTabInfo;
    api.tabs[API]?.push(chat);
    const result = await nexus(api, ["chat", "send", "eeee", "hi", "--workspace", "api"]);
    expect(result.stderr).toBe("nexus: the user did not allow it\n");
    expect(api.asked[0]?.change).toEqual({
      kind: "chatInput",
      detail: "Fix the login",
      body: "hi",
    });
    expect(api.chatSent).toEqual([]);
  });
});

describe("chat wait", () => {
  test("waits on several tabs for the first one done, and tells which", async () => {
    const app = withChat({ state: "working" });
    app.tabs[APP]?.push({
      id: DOCS_TAB,
      type: "codex",
      title: "Docs",
      groupId: "g1",
      shown: false,
    });
    app.chats.set(DOCS_TAB, { info: { agent: "codex", state: "working" }, entries: [] });
    app.time.onTick = () => {
      app.chats.set(DOCS_TAB, {
        info: { agent: "codex", state: "idle", message: "Wrote the docs." },
        entries: [],
      });
    };
    const result = await nexus(app, ["chat", "wait", "eeee", "ffff", "--json"]);
    expect(JSON.parse(result.stdout)).toEqual({
      tabId: DOCS_TAB,
      workspaceId: APP,
      state: "idle",
      message: "Wrote the docs.",
    });

    const busy = withChat({ state: "working" });
    busy.tabs[APP]?.push({
      id: DOCS_TAB,
      type: "codex",
      title: "Docs",
      groupId: "g1",
      shown: false,
    });
    busy.chats.set(DOCS_TAB, { info: { agent: "codex", state: "working" }, entries: [] });
    const out = await nexus(busy, ["chat", "wait", "eeee", "ffff", "--timeout", "2s"]);
    expect(out.exitCode).toBe(124);
    expect(out.stdout).toContain("every tab was still working");
  });

  test("waits no more once its client has gone, as one stopped with Ctrl-C", async () => {
    const app = withChat({ state: "working" });
    const stop = new AbortController();
    const startedAt = app.time.now;
    app.time.onTick = () => stop.abort();
    const ctx = contextFor(app, ["chat", "wait", "eeee", "--timeout", "30m"]);
    const result = await runCli(CLI_COMMANDS, { ...ctx, signal: stop.signal });
    expect(result.exitCode).toBe(124);
    expect(app.time.now - startedAt).toBeLessThan(60_000);
    expect(app.waits.snapshot()).toEqual([]);
  });
});

/** What the Claude tab "Fix the login" runs with: Sonnet, in the default mode. */
function withChoices(info: Partial<CliChatInfo> = {}): FakeApp {
  const app = withChat(info);
  app.chatChoices.set(CHAT_TAB, {
    agent: "claude",
    model: "sonnet",
    effort: null,
    mode: "default",
    models: [
      { value: "default", name: "Default (recommended)" },
      { value: "sonnet", name: "Sonnet" },
    ],
    efforts: ["low", "high"],
  });
  return app;
}

function addCaller(
  app: FakeApp,
  agent: ChatAgent,
  mode: string | undefined,
  verified?: boolean,
): CliCaller {
  app.tabs[APP]?.push({
    id: CALLER_TAB,
    type: agent,
    title: "Caller",
    groupId: "g1",
    shown: false,
  });
  if (mode !== undefined) {
    app.chatChoices.set(CALLER_TAB, {
      agent,
      mode,
      model: null,
      effort: null,
      models: [],
      efforts: [],
    });
  }
  return { workspaceId: APP, tabId: CALLER_TAB, ...(verified === undefined ? {} : { verified }) };
}

describe("chat set", () => {
  test("sets the model and effort, and a mode that lets less run, without asking", async () => {
    const app = withChoices();
    const result = await nexus(app, [
      "chat",
      "set",
      "eeee",
      "--model",
      "default",
      "--effort",
      "high",
      "--mode",
      "PLAN",
    ]);
    expect(result.stdout).toBe(
      "Fix the login (eeeeeeee) now runs with model default, effort high, mode plan.\n",
    );
    expect(app.asked).toEqual([]);
    expect(app.uiCalls.filter((c) => c.op === "chat.settings").at(-1)?.args).toEqual({
      workspaceId: APP,
      tabId: CHAT_TAB,
      settings: { model: "default", effort: "high", mode: "plan" },
      expectedMode: "default",
    });
  });

  test("asks the user each time for a mode that lets more run", async () => {
    const app = withChoices();
    app.answers.push("once");
    const result = await nexus(app, ["chat", "set", "eeee", "--mode", "acceptEdits"]);
    expect(result.exitCode).toBe(0);
    expect(app.asked.map((r) => r.change)).toEqual([
      { kind: "chatMode", detail: '"Fix the login" (default → acceptEdits)' },
    ]);
    const denied = withChoices();
    expect((await nexus(denied, ["chat", "set", "eeee", "--mode", "auto"])).stderr).toBe(
      "nexus: the user did not allow it\n",
    );
    expect(denied.chatChoices.get(CHAT_TAB)?.mode).toBe("default");
  });

  test("leaves the mode that lets everything run to the user, and knows each agent's modes", async () => {
    const app = withChoices();
    const bypass = await nexus(app, ["chat", "set", "eeee", "--mode", "bypassPermissions"]);
    expect(bypass.exitCode).toBe(1);
    expect(bypass.stderr).toContain("only the user picks it");
    const codex = await nexus(app, ["chat", "set", "eeee", "--mode", "readOnly"]);
    expect(codex.exitCode).toBe(2);
    expect(codex.stderr).toContain('Claude has no mode "readOnly"');
    expect(app.uiCalls.some((c) => c.op === "chat.settings")).toBe(false);
  });

  test("changes no setting of its own tab", async () => {
    const app = withChoices();
    const own = { workspaceId: APP, tabId: CHAT_TAB };
    const result = await nexus(app, ["chat", "set", "eeee", "--model", "default"], own);
    expect(result.stderr).toContain("that is this tab");
  });
});

describe("chat new with settings", () => {
  test("sets them before the prompt, asking for a mode that lets more run", async () => {
    const app = fakeApp();
    app.answers.push("once");
    const result = await nexus(app, [
      "chat",
      "new",
      "--prompt",
      "go",
      "--model",
      "haiku",
      "--mode",
      "acceptEdits",
      "--json",
    ]);
    expect(JSON.parse(result.stdout)).toMatchObject({
      tabId: NEW_TAB,
      settings: { model: "haiku", mode: "acceptEdits" },
    });
    expect(app.asked[0]?.change).toEqual({
      kind: "chatMode",
      detail: '"Claude" (default → acceptEdits)',
    });
    expect(uiArgs(app, "chat.open")).toMatchObject({
      prompt: "go",
      settings: { model: "haiku", mode: "acceptEdits" },
    });
  });

  test("says when the tab could not take them, and that the prompt was not sent", async () => {
    const app = fakeApp();
    app.chatOpenError.message = 'it offers no model "gpt"; it offers default, sonnet';
    const result = await nexus(app, ["chat", "new", "--prompt", "go", "--model", "gpt"]);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe(
      'Opened Claude tab cccccccc in /w/app, but could not set it: it offers no model "gpt"; it offers default, sonnet. The prompt was not sent.\n',
    );
  });

  test("reports a failed first prompt even when no settings were requested", async () => {
    const app = withChoices();
    app.uiAnswers.set("chat.open", { tabId: NEW_TAB, error: "Claude startup failed" });
    const result = await nexus(app, ["chat", "new", "--prompt", "Review this", "--json"]);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      tabId: NEW_TAB,
      error: "Claude startup failed",
    });
  });

  test("does not open a chat after the client cancels during workspace approval", async () => {
    const app = withChoices();
    const controller = new AbortController();
    const pending = Promise.withResolvers<void>();
    const arrived = Promise.withResolvers<void>();
    app.services.allowChange = async (_request, signal) => {
      expect(signal).toBe(controller.signal);
      arrived.resolve();
      await pending.promise;
    };
    const result = runCli(CLI_COMMANDS, {
      ...contextFor(app, ["chat", "new", "--workspace", "api"]),
      signal: controller.signal,
    });
    await arrived.promise;
    controller.abort();
    pending.resolve();
    expect((await result).exitCode).toBe(1);
    expect(uiArgs(app, "chat.open")).toBeUndefined();
  });
});

describe("delegating a chat mode", () => {
  type Outcome = "grant" | "ask" | "refuse" | "unchanged consent";
  const rows: [
    ChatAgent,
    string | undefined,
    ChatAgent,
    string,
    boolean | undefined,
    Outcome,
    Outcome,
  ][] = [
    // Caller, mode, target, requested mode, verified, chat new, chat set.
    ["claude", "auto", "claude", "acceptEdits", true, "grant", "grant"],
    ["claude", "acceptEdits", "claude", "auto", true, "ask", "ask"],
    ["codex", "auto", "claude", "auto", true, "grant", "grant"],
    ["claude", "acceptEdits", "codex", "auto", true, "unchanged consent", "grant"],
    ["codex", "readOnly", "codex", "auto", true, "unchanged consent", "ask"],
    ["claude", "bypassPermissions", "codex", "fullAccess", true, "grant", "grant"],
    ["codex", "fullAccess", "claude", "bypassPermissions", true, "grant", "grant"],
    ["claude", "bypassPermissions", "claude", "bypassPermissions", true, "grant", "grant"],
    ["codex", "fullAccess", "codex", "fullAccess", true, "grant", "grant"],
    ["codex", "auto", "codex", "fullAccess", true, "refuse", "refuse"],
    ["claude", "bypassPermissions", "claude", "bypassPermissions", false, "refuse", "refuse"],
    ["codex", "fullAccess", "codex", "fullAccess", undefined, "refuse", "refuse"],
    ["claude", "auto", "claude", "acceptEdits", false, "ask", "ask"],
    ["claude", "auto", "claude", "acceptEdits", undefined, "ask", "ask"],
    ["codex", "future", "claude", "auto", true, "ask", "ask"],
    ["codex", undefined, "claude", "bypassPermissions", true, "refuse", "refuse"],
    ["codex", undefined, "claude", "default", true, "unchanged consent", "grant"],
  ];

  test.each(
    rows,
  )("%s %s requesting %s %s with verification %s gives new=%s and set=%s", async (agent, mode, target, wanted, verified, onNew, onSet) => {
    for (const [command, expected] of [
      ["new", onNew],
      ["set", onSet],
    ] as const) {
      const app = withChoices({ agent: target });
      const caller = addCaller(app, agent, mode, verified);
      const from = target === "claude" ? "plan" : "readOnly";
      app.chatChoices.set(CHAT_TAB, {
        agent: target,
        mode: from,
        model: null,
        effort: null,
        models: [],
        efforts: [],
      });
      app.answers.push("once");
      const selector = command === "new" ? ["--agent", target] : ["eeee"];
      const result = await nexus(app, ["chat", command, ...selector, "--mode", wanted], caller);
      const mutation = app.uiCalls.find(
        (c) =>
          c.op === "chat.open" ||
          (c.op === "chat.settings" &&
            Object.keys((c.args as { settings: object }).settings).length > 0),
      );
      expect(app.asked.map((ask) => ask.change.kind)).toEqual(
        expected === "ask" ? ["chatMode"] : [],
      );
      if (expected === "refuse") {
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain("only the user picks it");
        expect(mutation).toBeUndefined();
      } else {
        expect(result.exitCode).toBe(0);
        expect(mutation?.args).toMatchObject({ settings: { mode: wanted } });
        if (wanted === "fullAccess" || wanted === "bypassPermissions") {
          expect(mutation?.args).toMatchObject({ allowDangerousMode: true });
        }
      }
    }
  });

  test("checks the cross-workspace policy before reading the caller's mode", async () => {
    const denied = withChoices();
    const caller = addCaller(denied, "codex", "fullAccess", true);
    denied.settings.crossWorkspace = "deny";
    const result = await nexus(
      denied,
      ["chat", "new", "--workspace", "api", "--mode", "bypassPermissions"],
      caller,
    );
    expect(result.stderr).toContain("changing other workspaces is turned off");
    expect(denied.uiCalls).toEqual([]);

    const asked = withChoices();
    addCaller(asked, "codex", "fullAccess", true);
    asked.answers.push("once");
    expect(
      (
        await nexus(
          asked,
          ["chat", "new", "--workspace", "api", "--mode", "bypassPermissions"],
          caller,
        )
      ).exitCode,
    ).toBe(0);
    expect(asked.asked.map((request) => request.change.kind)).toEqual(["chatNew"]);
  });

  test("retains consent if the mode read fails or the caller runs over SSH", async () => {
    const app = withChoices();
    const caller = addCaller(app, "claude", "bypassPermissions", true);
    app.uiAnswers.set("chat.mode", () => {
      throw new Error("renderer closed");
    });
    app.answers.push("once");
    expect((await nexus(app, ["chat", "new", "--mode", "auto"], caller)).exitCode).toBe(0);
    expect(app.asked.map((request) => request.change.kind)).toEqual(["chatMode"]);

    const ssh = withChoices();
    const workspace = ssh.workspaces.find((w) => w.id === APP);
    if (workspace) workspace.location = { kind: "ssh", host: "test", remotePath: "/w/app" };
    addCaller(ssh, "claude", "bypassPermissions", true);
    const result = await nexus(ssh, ["chat", "new", "--mode", "bypassPermissions"], caller);
    expect(result.stderr).toContain("only the user picks it");
    expect(ssh.uiCalls).toEqual([]);
  });
});

describe("delegating a chat answer", () => {
  const rows: [ChatAgent, string | undefined, boolean | undefined, boolean][] = [
    ["claude", "bypassPermissions", true, false],
    ["codex", "fullAccess", true, false],
    ["claude", "bypassPermissions", false, true],
    ["codex", "fullAccess", undefined, true],
    ["claude", "auto", true, true],
    ["codex", "auto", true, true],
    ["claude", "plan", true, true],
    ["codex", "readOnly", true, true],
    ["codex", "future", true, true],
    ["claude", undefined, true, true],
  ];
  const request = { id: "req-1", tool: "Bash", input: "make test" };

  test.each(
    rows,
  )("%s %s, verified %s, needs a user prompt = %s", async (agent, mode, verified, asks) => {
    for (const target of ["claude", "codex"] as const) {
      for (const decision of ["allow", "deny"] as const) {
        const app = withChat({
          agent: target,
          state: "asking",
          message: "asks to run Bash",
          request,
        });
        const caller = addCaller(app, agent, mode, verified);
        app.answers.push("once");
        const result = await nexus(app, ["chat", "answer", "eeee", decision], caller);
        expect(result.exitCode).toBe(0);
        expect(app.asked.map((ask) => ask.change)).toEqual(
          asks
            ? [
                {
                  kind: decision === "allow" ? "permissionAllow" : "permissionDeny",
                  detail: "Bash (Fix the login)",
                  body: request.input,
                },
              ]
            : [],
        );
        expect(app.chatAnswered).toEqual([
          { workspaceId: APP, tabId: CHAT_TAB, decision, expect: request.id },
        ]);
      }
    }
  });

  test.each([
    "AskUserQuestion",
    "ExitPlanMode",
  ])("leaves %s to the user even for full access", async (tool) => {
    const app = withChat({
      state: "asking",
      message: `asks to run ${tool}`,
      request: { ...request, tool },
    });
    const caller = addCaller(app, "codex", "fullAccess", true);
    for (const decision of ["allow", "deny"]) {
      const result = await nexus(app, ["chat", "answer", "eeee", decision], caller);
      expect(result.stderr).toContain("the user's to answer in the app");
    }
    expect(app.chatAnswered).toEqual([]);
    expect(app.asked).toEqual([]);
  });

  test.each([
    "always",
    "updatedInput",
    "planMode",
  ])("does not take a %s answer option", async (option) => {
    const app = withChat({ state: "asking", message: "asks to run Bash", request });
    const caller = addCaller(app, "codex", "fullAccess", true);
    const result = await nexus(app, ["chat", "answer", "eeee", "allow", `--${option}`], caller);
    expect(result.exitCode).toBe(2);
    expect(app.chatAnswered).toEqual([]);
  });

  test("answers the terminal's original request once with a verified unrestricted caller", async () => {
    const app = withChat();
    const caller = addCaller(app, "claude", "bypassPermissions", true);
    app.terminalAsks.set(CLAUDE_TAB, [
      {
        id: "hook",
        tool: "Bash",
        target: "make test",
        since: 5,
        always: [{ kind: "rule", rule: "Bash(make *)" }],
      },
    ]);
    expect((await nexus(app, ["chat", "answer", "✳ Claude Code", "allow"], caller)).exitCode).toBe(
      0,
    );
    expect(app.asked).toEqual([]);
    expect(app.terminalAnswered).toEqual([{ tabId: CLAUDE_TAB, askId: "hook", answer: "allow" }]);
  });

  test.each([
    ["allow", false, 0, 0],
    ["ask", false, 1, 0],
    ["deny", false, 0, 1],
    ["ask", true, 2, 1],
  ] as const)("honors workspace policy %s when caller is downgraded = %s", async (policy, downgrade, prompts, exitCode) => {
    const app = withChat({ state: "asking", message: "asks to run Bash", request });
    const caller = addCaller(app, "codex", "fullAccess", true);
    const tab = app.tabs[APP]?.find((t) => t.id === CHAT_TAB);
    if (tab) {
      app.tabs[APP] = app.tabs[APP]?.filter((t) => t !== tab) ?? [];
      app.tabs[API]?.push(tab);
    }
    app.settings.crossWorkspace = policy;
    app.answers.push("once");
    if (downgrade) {
      const allowChange = app.services.allowChange;
      app.services.allowChange = async (change) => {
        await allowChange(change);
        const choices = app.chatChoices.get(CALLER_TAB);
        if (choices) app.chatChoices.set(CALLER_TAB, { ...choices, mode: "auto" });
      };
    }
    const result = await nexus(
      app,
      ["chat", "answer", "eeee", "allow", "--workspace", "api"],
      caller,
    );
    expect(result.exitCode).toBe(exitCode);
    expect(app.asked.map((ask) => ask.change.kind)).toEqual(Array(prompts).fill("permissionAllow"));
    expect(app.chatAnswered).toHaveLength(exitCode === 0 ? 1 : 0);
  });
});

describe("who sends a message", () => {
  test("a tab's agent, Claude Code in a terminal and the manager are named; the user at a shell is not", async () => {
    const app = withChat();
    app.tabs[APP]?.push({
      id: DOCS_TAB,
      type: "codex",
      title: "Plan the refactor",
      groupId: "g1",
      shown: false,
    });
    const at = (tabId: string) => contextFor(app, [], { workspaceId: APP, tabId });
    expect(await senderOf(at(DOCS_TAB))).toEqual({
      kind: "tab",
      agent: "codex",
      name: "Plan the refactor",
      workspaceId: APP,
      tabId: DOCS_TAB,
    });
    expect(await senderOf(at(CLAUDE_TAB))).toEqual({
      kind: "terminal",
      agent: "claude",
      name: "✳ Claude Code",
      workspaceId: APP,
      tabId: CLAUDE_TAB,
    });
    expect(await senderOf(at(SHELL_TAB))).toBeUndefined();
  });

  test("an agent's message goes however many agents' messages led to it", async () => {
    const app = withChat();
    app.tabs[APP]?.push({
      id: DOCS_TAB,
      type: "codex",
      title: "Plan",
      groupId: "g1",
      shown: false,
    });
    const docs = { workspaceId: APP, tabId: DOCS_TAB };
    for (let i = 0; i < 12; i++) {
      const sent = await nexus(app, ["chat", "send", "eeee", `again ${i}`], docs);
      expect(sent.exitCode).toBe(0);
    }
  });

  test("one that could be any process's, or names no terminal or chat tab, is an agent's, not the user's", async () => {
    const app = withChat();
    const unknown = (tabId: string) => ({ kind: "terminal", workspaceId: APP, tabId });
    // The user's shell, but the request came without that tab's token: any process may say it.
    expect(
      await senderOf(contextFor(app, [], { workspaceId: APP, tabId: SHELL_TAB, verified: false })),
    ).toEqual(unknown(SHELL_TAB));
    expect(
      await senderOf(contextFor(app, [], { workspaceId: APP, tabId: SHELL_TAB, verified: true })),
    ).toBeUndefined();
    // No such tab.
    const gone = "99999999-0000-4000-8000-000000000099";
    expect(await senderOf(contextFor(app, [], { workspaceId: APP, tabId: gone }))).toEqual(
      unknown(gone),
    );
  });

  test("an agent a terminal started that has said nothing yet is found by the terminal's program now", async () => {
    const app = withChat();
    const at = contextFor(app, [], { workspaceId: APP, tabId: SHELL_TAB });
    // codex exec runs its first command before any output: the terminal's
    // state still has the shell, the foreground has codex.
    app.foreground.set(SHELL_TAB, "codex");
    expect(await senderOf(at)).toEqual({
      kind: "terminal",
      agent: "codex",
      name: expect.any(String),
      workspaceId: APP,
      tabId: SHELL_TAB,
    });
    app.foreground.set(SHELL_TAB, "zsh");
    expect(await senderOf(at)).toBeUndefined();
  });

  test("chat send and chat new --prompt tell the tab who sent it, when an agent did", async () => {
    const app = withChat();
    const claude = { workspaceId: APP, tabId: CLAUDE_TAB };
    expect((await nexus(app, ["chat", "send", "eeee", "run the tests"], claude)).exitCode).toBe(0);
    expect(uiArgs(app, "chat.send")).toMatchObject({
      text: "run the tests",
      from: { kind: "terminal", agent: "claude", tabId: CLAUDE_TAB },
    });
    await nexus(app, ["chat", "new", "--prompt", "look at the docs"], claude);
    expect(uiArgs(app, "chat.open")).toMatchObject({ from: { kind: "terminal" } });
    // Whether it waits to read the answer is told only where it is known.
    expect((uiArgs(app, "chat.open") as { from: object }).from).not.toHaveProperty("waits");
    const user = withChat();
    await nexus(user, ["chat", "send", "eeee", "run the tests"]);
    expect(uiArgs(user, "chat.send")).not.toHaveProperty("from");
  });

  test("chat send tells the tab whether its sender waits to read the answer", async () => {
    const app = withChat();
    const claude = { workspaceId: APP, tabId: CLAUDE_TAB };
    await nexus(app, ["chat", "send", "eeee", "run the tests"], claude);
    await nexus(
      app,
      ["chat", "send", "eeee", "run the tests", "--wait", "--timeout", "1s"],
      claude,
    );
    const sent = app.uiCalls.filter((c) => c.op === "chat.send").map((c) => c.args);
    expect(sent).toMatchObject([{ from: { waits: false } }, { from: { waits: true } }]);
  });
});

describe("chat set --profile", () => {
  test("asks the user each time, then has the tab go on in that profile, or start anew with --new", async () => {
    const app = withChat();
    app.answers.push("once", "once");
    const result = await nexus(app, ["chat", "set", "eeee", "--profile", "Work"]);
    expect(result.stdout).toBe(
      'Fix the login (eeeeeeee) now runs with the profile "Work"; its conversation goes on there.\n',
    );
    const fresh = await nexus(app, ["chat", "set", "eeee", "--profile", "Work", "--new"]);
    expect(fresh.stdout).toContain('"Work", in a new conversation.');
    expect(app.asked.map((r) => r.change)).toEqual([
      { kind: "chatProfile", detail: '"Fix the login" (default → Work)' },
      { kind: "chatProfileNew", detail: '"Fix the login" (default → Work)' },
    ]);
    const calls = app.uiCalls.filter((c) => c.op === "chat.profile").map((c) => c.args);
    expect(calls).toEqual([
      { workspaceId: APP, tabId: CHAT_TAB, profile: "Work", fresh: false, dryRun: true },
      { workspaceId: APP, tabId: CHAT_TAB, profile: "Work", fresh: false },
      { workspaceId: APP, tabId: CHAT_TAB, profile: "Work", fresh: true, dryRun: true },
      { workspaceId: APP, tabId: CHAT_TAB, profile: "Work", fresh: true },
    ]);
  });

  test("changes nothing the user did not allow, a profile the agent lacks, or its own tab's", async () => {
    const denied = withChat();
    expect((await nexus(denied, ["chat", "set", "eeee", "--profile", "Work"])).stderr).toBe(
      "nexus: the user did not allow it\n",
    );
    expect(denied.uiCalls.filter((c) => c.op === "chat.profile")).toHaveLength(1);
    const lacking = withChat();
    const none = await nexus(lacking, ["chat", "set", "eeee", "--profile", "nope"]);
    expect(none.stderr).toContain('claude has no profile "nope"');
    expect(lacking.asked).toEqual([]);
    const own = { workspaceId: APP, tabId: CHAT_TAB };
    const self = await nexus(withChat(), ["chat", "set", "eeee", "--profile", "Work"], own);
    expect(self.stderr).toContain("its profile is the user's to change");
    const app = withChat();
    expect((await nexus(app, ["chat", "set", "eeee", "--new"])).stderr).toContain(
      "--new goes with --profile",
    );
    const both = await nexus(app, ["chat", "set", "eeee", "--profile", "Work", "--model", "x"]);
    expect(both.stderr).toContain("--profile goes alone");
  });
});

describe("a tab's profile and goal", () => {
  test("chat read and session list tell them", async () => {
    const app = withChat({
      profile: "Work",
      goal: { objective: "All tests pass", status: "met", reason: "bun test is green" },
    });
    const read = await nexus(app, ["chat", "read", "eeee"]);
    expect(read.stdout).toEndWith(
      "Claude in Fix the login is idle.\nProfile: Work.\nGoal, met: All tests pass (bun test is green)\n",
    );
    const json = JSON.parse((await nexus(app, ["chat", "read", "eeee", "--json"])).stdout);
    expect([json.profile, json.goal.status]).toEqual(["Work", "met"]);
    const list = await nexus(app, ["session", "list"]);
    const row = list.stdout.split("\n").find((line) => line.includes("Fix the login")) ?? "";
    expect(row).toContain("claude-tab (Work)");
    expect(row).toContain("idle · goal met");
  });
});

describe("chat instructions", () => {
  test("reads the caller's UTF-8 file for chat new and leaves the prompt separate", async () => {
    const app = fakeApp();
    const file = "/w/app/test-new-rules.md";
    READABLE[file] = "검토만 합니다.";
    try {
      const result = await nexus(app, [
        "chat",
        "new",
        "--instructions-file",
        "test-new-rules.md",
        "--prompt",
        "review",
      ]);
      expect(result.exitCode).toBe(0);
      expect(uiArgs(app, "chat.open")).toMatchObject({
        instructions: "검토만 합니다.",
        prompt: "review",
      });
    } finally {
      delete READABLE[file];
    }
  });

  test("shows, sets, and clears a tab without starting its agent", async () => {
    const app = withChat();
    const file = "/w/app/test-session-rules.md";
    READABLE[file] = "session rule";
    try {
      expect(
        (await nexus(app, ["chat", "instructions", "eeee", "--set-file", file])).exitCode,
      ).toBe(0);
      expect((await nexus(app, ["chat", "instructions", "eeee", "--show"])).stdout).toBe(
        "session rule\n",
      );
      expect((await nexus(app, ["chat", "instructions", "eeee", "--clear"])).exitCode).toBe(0);
      expect((await nexus(app, ["chat", "instructions", "eeee", "--show"])).stdout).toBe("");
      expect(app.uiCalls.every(({ op }) => op === "tabs.list" || op === "chat.instructions")).toBe(
        true,
      );
    } finally {
      delete READABLE[file];
    }
  });

  test("rejects invalid operations, oversized layers, and unavailable peer instructions", async () => {
    const app = withChat();
    expect(
      (await nexus(app, ["chat", "instructions", "eeee", "--show", "--clear"])).stderr,
    ).toContain("exactly one");
    expect(
      (await nexus(app, ["chat", "instructions", "eeee", "--show", "--device", "elsewhere"]))
        .stderr,
    ).toContain('no device "elsewhere"');
    expect(
      (await nexus(app, ["chat", "new", "--instructions-file", "missing", "--device", "elsewhere"]))
        .stderr,
    ).toContain("omit --device");
    const file = "/w/app/test-large-rules.md";
    READABLE[file] = "x".repeat(INSTRUCTION_LIMIT + 1);
    try {
      expect(
        (await nexus(app, ["chat", "instructions", "eeee", "--set-file", file])).stderr,
      ).toContain(String(INSTRUCTION_LIMIT));
    } finally {
      delete READABLE[file];
    }
  });
});
