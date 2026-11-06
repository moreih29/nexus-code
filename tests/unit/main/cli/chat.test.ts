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
      { role: "user", text: "Fix the login redirect" },
      { role: "agent", text: "Looking at the router." },
      { role: "tool", text: "Read src/router.ts" },
      { role: "agent", text: "Fixed it: the redirect keeps the page." },
    ],
  });
  return app;
}

describe("chat new", () => {
  test("opens a Claude tab here behind this terminal, and says how to wait for it", async () => {
    const app = fakeApp();
    const result = await nexus(app, ["chat", "new", "--prompt", " summarize the README "]);
    expect(result.stdout).toBe(
      "Opened Claude tab cccccccc in /w/app and sent it the prompt. To wait for it:\n" +
        "  nexus chat wait cccccccc\n",
    );
    expect(uiArgs(app, "chat.open")).toEqual({
      workspaceId: APP,
      agent: "claude",
      cwd: "/w/app",
      prompt: "summarize the README",
      placement: { background: true, besideTabId: SHELL_TAB },
    });
    expect(app.asked).toEqual([]);
  });

  test("a Codex tab in another workspace, shown, once the user allows it", async () => {
    const app = fakeApp();
    app.answers.push("once");
    const result = await nexus(app, [
      "chat",
      "new",
      "--agent",
      "codex",
      "--show",
      "--workspace",
      "api",
      "--json",
    ]);
    expect(JSON.parse(result.stdout)).toEqual({
      tabId: NEW_TAB,
      workspaceId: API,
      agent: "codex",
      cwd: "/w/api",
    });
    expect(app.asked[0]?.change).toEqual({ kind: "chatNew", detail: "Codex" });
    expect(uiArgs(app, "chat.open")).toMatchObject({
      prompt: "",
      placement: { background: false },
    });
  });
});

describe("chat read", () => {
  test("prints the last messages under who said them, then where the tab stands", async () => {
    const app = withChat({ message: "Fixed it: the redirect keeps the page." });
    const result = await nexus(app, ["chat", "read", "eeee", "--messages", "3"]);
    expect(result.stdout).toBe(
      "── claude\nLooking at the router.\n" +
        "[tool] Read src/router.ts\n" +
        "── claude\nFixed it: the redirect keeps the page.\n\n" +
        "Claude in Fix the login is idle.\n",
    );
    expect(uiArgs(app, "chat.read")).toEqual({ workspaceId: APP, tabId: CHAT_TAB, messages: 3 });
  });

  test("names only Claude and Codex tabs", async () => {
    const result = await nexus(withChat(), ["chat", "read", "aaaa"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Claude or Codex tab");
  });
});

describe("chat send", () => {
  test("sends the text, from stdin with -", async () => {
    const app = withChat();
    expect((await nexus(app, ["chat", "send", "Fix the login", "add", "a", "test"])).stdout).toBe(
      "Sent to Fix the login (eeeeeeee).\n",
    );
    await nexus(app, ["chat", "send", "eeee", "-"], undefined, "from stdin\n");
    expect(app.chatSent).toEqual([
      { tabId: CHAT_TAB, text: "add a test" },
      { tabId: CHAT_TAB, text: "from stdin" },
    ]);
  });

  test("--wait waits until the turn ends and prints the answer", async () => {
    const app = withChat({ state: "working" });
    app.time.onTick = () => {
      if (app.chatSent.length > 0) {
        app.chats.set(CHAT_TAB, {
          info: { agent: "claude", state: "idle", message: "Added the test." },
          entries: [],
        });
      }
    };
    const result = await nexus(app, ["chat", "send", "eeee", "add", "a", "test", "--wait"]);
    expect(result.stdout).toBe(
      "Sent to Fix the login (eeeeeeee).\nClaude in Fix the login finished:\nAdded the test.\n",
    );
    expect(result.exitCode).toBe(0);
  });

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
  test("returns when the agent waits for the user", async () => {
    const app = withChat({ state: "working" });
    app.time.onTick = () => {
      app.chats.set(CHAT_TAB, {
        info: { agent: "claude", state: "asking", message: "asks to run Bash npm test" },
        entries: [],
      });
    };
    const result = await nexus(app, ["chat", "wait", "eeee", "--json"]);
    expect(JSON.parse(result.stdout)).toEqual({
      tabId: CHAT_TAB,
      workspaceId: APP,
      state: "asking",
      message: "asks to run Bash npm test",
    });
  });

  test("tells an error, a closed tab, and a wait that ran out with 124", async () => {
    const failed = withChat({ state: "error", message: "claude was not found" });
    expect((await nexus(failed, ["chat", "wait", "eeee"])).stdout).toBe(
      "Claude in Fix the login stopped on an error: claude was not found\n",
    );

    const closed = withChat({ state: "working" });
    closed.time.onTick = () => {
      closed.tabs[APP] = closed.tabs[APP]?.filter((t) => t.id !== CHAT_TAB) ?? [];
    };
    expect((await nexus(closed, ["chat", "wait", "eeee"])).stdout).toBe(
      "Fix the login was closed.\n",
    );

    const busy = withChat({ state: "working" });
    const result = await nexus(busy, ["chat", "wait", "eeee", "--timeout", "2s"]);
    expect(result.exitCode).toBe(124);
    expect(result.stdout).toContain("was still working when the wait ran out");
    // The wait is listed while it runs, and not after.
    expect(busy.waits.snapshot()).toEqual([]);
  });
});

describe("session list", () => {
  test("lists the Claude and Codex tabs beside the terminals, each in its workspace", async () => {
    const app = withChat({ state: "working", message: "Looking at the router." });
    const sessions = JSON.parse((await nexus(app, ["session", "list", "--json"])).stdout) as Array<
      Record<string, unknown>
    >;
    expect(sessions.map((s) => [s.workspace, s.agent, s.state, s.tab ?? "terminal"])).toEqual([
      ["app", "claude", "completed", "terminal"],
      ["app", "claude", "working", "claude"],
      ["api", "codex", "busy", "terminal"],
    ]);
    expect(uiArgs(app, "chat.state")).toEqual({ workspaceId: APP, tabId: CHAT_TAB, peek: true });
  });
});
