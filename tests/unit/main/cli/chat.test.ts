/**
 * nexus chat new, read, send and wait: the app's Claude and Codex tabs,
 * driven from a terminal as their composer drives them.
 */
import { describe, expect, test } from "bun:test";
import { CLI_COMMANDS } from "../../../../src/main/features/cli/commands";
import { runCli } from "../../../../src/main/features/cli/registry";
import type { CliChatInfo, CliTabInfo } from "../../../../src/shared/cli/ui";
import { API, APP, contextFor, type FakeApp, fakeApp, NEW_TAB, SHELL_TAB } from "./fake-services";

const CHAT_TAB = "eeeeeeee-0000-4000-8000-000000000008";
const DOCS_TAB = "ffffffff-0000-4000-8000-000000000009";

async function nexus(
  app: FakeApp,
  argv: string[],
  caller = { workspaceId: APP, tabId: SHELL_TAB },
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
    type: "claude",
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
    expect(api.asked[0]?.change).toEqual({ kind: "chatInput", detail: "Fix the login" });
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
    expect(app.dispatched).toEqual([]);
  });
});
