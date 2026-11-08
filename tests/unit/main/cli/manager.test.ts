/**
 * nexus as the agent manager runs it: in no workspace, directing every one
 * without asking, its handed-out work told to the app; and chat answer, a
 * tab's permission request answered as Settings › Agent manager says.
 */
import { describe, expect, test } from "bun:test";
import { CLI_COMMANDS } from "../../../../src/main/features/cli/commands";
import { runCli } from "../../../../src/main/features/cli/registry";
import type { CliChatInfo } from "../../../../src/shared/cli/ui";
import { MANAGER_TAB_ID, MANAGER_WORKSPACE_ID } from "../../../../src/shared/manager/manager";
import {
  API,
  APP,
  CODEX_TAB,
  contextFor,
  type FakeApp,
  fakeApp,
  NEW_TAB,
  SHELL_TAB,
} from "./fake-services";

const MANAGER = { workspaceId: MANAGER_WORKSPACE_ID, tabId: MANAGER_TAB_ID };
const CHAT_TAB = "eeeeeeee-0000-4000-8000-000000000008";
/** A tab's request to run a command its row shows the first line of. */
const REQUEST = { id: "req-1", tool: "Bash", input: "npm publish\nrm -rf ~/.npmrc" };
const ASKS: Partial<CliChatInfo> = {
  state: "asking",
  message: "asks to run Bash npm publish",
  request: REQUEST,
};

async function nexus(app: FakeApp, argv: string[], caller = MANAGER) {
  return runCli(CLI_COMMANDS, contextFor(app, argv, caller));
}

/** "app" with a Claude tab in the state `info` says. */
function withChat(info: Partial<CliChatInfo> = {}): FakeApp {
  const app = fakeApp();
  app.tabs[APP]?.push({
    id: CHAT_TAB,
    type: "claude",
    title: "Release",
    groupId: "g1",
    shown: false,
  });
  app.chats.set(CHAT_TAB, { info: { agent: "claude", state: "idle", ...info }, entries: [] });
  return app;
}

describe("the agent manager", () => {
  test("is in no workspace: status says so, and what the user sees", async () => {
    const result = await nexus(fakeApp(), ["status"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("you are:   the agent manager, in no workspace\n");
    expect(result.stdout).toContain("user sees: app (11111111), tab aaaaaaaa");
  });

  test("works in the workspace the user sees when it gives none", async () => {
    const app = fakeApp();
    const result = await nexus(app, ["chat", "new", "--prompt", "add a test"]);
    expect(result.exitCode).toBe(0);
    expect(app.uiCalls.find((call) => call.op === "chat.open")?.args).toMatchObject({
      workspaceId: APP,
    });
  });

  test("changes another workspace without asking the user", async () => {
    const app = fakeApp();
    const result = await nexus(app, ["terminal", "send", "codex", "go on", "--workspace", "api"]);
    expect(result.exitCode).toBe(0);
    expect(app.asked).toEqual([]);
    expect(app.uiCalls.find((call) => call.op === "terminal.input")?.args).toMatchObject({
      tabId: CODEX_TAB,
    });
  });

  test("tells the app the sessions it hands work to, and what it sent them", async () => {
    const app = withChat();
    await nexus(app, ["chat", "new", "--prompt", " add a test ", "--workspace", "api"]);
    await nexus(app, ["chat", "send", "release", "ship it", "--workspace", "app"]);
    await nexus(app, ["terminal", "send", "codex", "go on", "--workspace", "api"]);
    expect(app.dispatched).toEqual([
      { workspaceId: API, tabId: NEW_TAB, text: "add a test" },
      { workspaceId: APP, tabId: CHAT_TAB, text: "ship it" },
      { workspaceId: API, tabId: CODEX_TAB, text: "go on" },
    ]);
  });

  test("a terminal or a tab hands nothing to the manager's list", async () => {
    const app = withChat();
    await nexus(app, ["chat", "send", "release", "ship it"], {
      workspaceId: APP,
      tabId: SHELL_TAB,
    });
    expect(app.dispatched).toEqual([]);
  });
});

describe("chat answer", () => {
  test("is refused to the manager while the user answers permission requests", async () => {
    const app = withChat(ASKS);
    const result = await nexus(app, ["chat", "answer", "release", "allow", "--workspace", "app"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("the user answers other sessions' permission requests");
    // The whole command, for the manager to tell the user.
    expect(result.stderr).toContain("Release asks to run Bash:\n  npm publish\n  rm -rf ~/.npmrc");
    expect(app.chatAnswered).toEqual([]);
  });

  test("asks the user first when the setting says to, and answers when allowed", async () => {
    const app = withChat(ASKS);
    app.settings.managerPermissions = "ask";
    app.answers.push("once");
    const result = await nexus(app, ["chat", "answer", "release", "allow", "--workspace", "app"]);
    expect(result.stdout).toBe("Allowed Bash npm publish in Release.\n");
    expect(app.asked).toEqual([
      {
        fromWorkspaceId: MANAGER_WORKSPACE_ID,
        fromTabId: MANAGER_TAB_ID,
        toWorkspaceId: APP,
        // The user sees the command whole: its first line hides the second.
        change: { kind: "permissionAllow", detail: "Bash (Release)", body: REQUEST.input },
      },
    ]);
    expect(app.chatAnswered).toEqual([
      { workspaceId: APP, tabId: CHAT_TAB, decision: "allow", expect: REQUEST.id },
    ]);
  });

  test("answers nothing the user turns down", async () => {
    const app = withChat(ASKS);
    app.settings.managerPermissions = "ask";
    app.answers.push("deny");
    const result = await nexus(app, ["chat", "answer", "release", "deny", "--workspace", "app"]);
    expect(result.stderr).toBe("nexus: the user did not allow it\n");
    expect(app.chatAnswered).toEqual([]);
  });

  test("answers at once when the manager may, a deny with its reason", async () => {
    const app = withChat(ASKS);
    app.settings.managerPermissions = "answer";
    const argv = [
      "chat",
      "answer",
      "release",
      "deny",
      "--message",
      "not yet",
      "--workspace",
      "app",
    ];
    const result = await nexus(app, argv);
    expect(result.stdout).toBe("Denied Bash npm publish in Release.\n");
    expect(app.asked).toEqual([]);
    expect(app.chatAnswered).toEqual([
      {
        workspaceId: APP,
        tabId: CHAT_TAB,
        decision: "deny",
        message: "not yet",
        expect: REQUEST.id,
      },
    ]);
  });

  test("asks the user each time for any other caller, whatever the setting", async () => {
    const app = withChat(ASKS);
    app.settings.managerPermissions = "answer";
    app.answers.push("session", "deny");
    const shell = { workspaceId: APP, tabId: SHELL_TAB };
    await nexus(app, ["chat", "answer", "release", "allow"], shell);
    const again = await nexus(app, ["chat", "answer", "release", "allow"], shell);
    expect(app.asked).toHaveLength(2);
    expect(again.exitCode).toBe(1);
    expect(app.chatAnswered).toHaveLength(1);
  });

  test.each([
    ["it asks nothing", { state: "idle" } as const, "Release waits on no permission request"],
    [
      "it asks the user a question",
      { state: "asking", message: "asks: Which port?" } as const,
      "Release asks: Which port?; that is the user's to answer in the app",
    ],
  ])("is refused when %s", async (_, info, error) => {
    const app = withChat(info);
    app.settings.managerPermissions = "answer";
    const result = await nexus(app, ["chat", "answer", "release", "allow", "--workspace", "app"]);
    expect(result.stderr).toBe(`nexus: ${error}\n`);
    expect(app.chatAnswered).toEqual([]);
  });

  test.each([
    [["chat", "answer", "release", "maybe"], 'the answer is "allow" or "deny"'],
    [["chat", "answer", "release", "allow", "--message", "x"], "--message goes with deny"],
  ])("takes allow or deny: %p", async (argv, error) => {
    const result = await nexus(withChat(), [...argv, "--workspace", "app"]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain(error);
  });
});

describe("manager show, hide and new", () => {
  test("open and close its dock, saying when the manager is off", async () => {
    const app = fakeApp();
    const shell = { workspaceId: APP, tabId: SHELL_TAB };
    expect((await nexus(app, ["manager", "show"], shell)).stdout).toBe(
      "Opened the agent manager's dock.\n",
    );
    expect(app.uiCalls.at(-1)).toEqual({ op: "manager.dock", args: { open: true } });
    await nexus(app, ["manager", "hide"], shell);
    expect(app.uiCalls.at(-1)?.args).toEqual({ open: false });
    app.settings.managerEnabled = false;
    expect((await nexus(app, ["manager", "show"], shell)).stdout).toBe(
      "Opened the agent manager's dock. The agent manager is off (Settings › Agent manager).\n",
    );
  });

  test("new starts it over for another session, never for the manager itself", async () => {
    const app = fakeApp();
    const shell = { workspaceId: APP, tabId: SHELL_TAB };
    expect((await nexus(app, ["manager", "new"], shell)).stdout).toBe(
      "Started the agent manager over, in a new conversation.\n",
    );
    const own = await nexus(app, ["manager", "new"]);
    expect(own.exitCode).toBe(1);
    expect(own.stderr).toContain("that is this conversation");
  });
});

describe("chat set --mode by the manager", () => {
  function withChoices(): FakeApp {
    const app = withChat();
    app.chatChoices.set(CHAT_TAB, {
      agent: "claude",
      model: null,
      effort: null,
      mode: "plan",
      models: [],
      efforts: [],
    });
    return app;
  }
  const argv = ["chat", "set", "release", "--mode", "acceptEdits", "--workspace", "app"];

  test("is refused while the user answers permission requests", async () => {
    const app = withChoices();
    const result = await nexus(app, argv);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('ask them to set "Release" to acceptEdits');
    expect(app.chatChoices.get(CHAT_TAB)?.mode).toBe("plan");
  });

  test("asks the user, or sets it at once, as the setting says", async () => {
    const asking = withChoices();
    asking.settings.managerPermissions = "ask";
    asking.answers.push("once");
    expect((await nexus(asking, argv)).exitCode).toBe(0);
    expect(asking.asked.map((r) => r.change.kind)).toEqual(["chatMode"]);

    const answering = withChoices();
    answering.settings.managerPermissions = "answer";
    expect((await nexus(answering, argv)).exitCode).toBe(0);
    expect(answering.asked).toEqual([]);
    expect(answering.chatChoices.get(CHAT_TAB)?.mode).toBe("acceptEdits");
  });

  test("sets a mode that lets less run without asking", async () => {
    const app = withChoices();
    app.chatChoices.set(CHAT_TAB, { ...(app.chatChoices.get(CHAT_TAB) as never), mode: "auto" });
    expect((await nexus(app, argv)).exitCode).toBe(0);
    expect(app.asked).toEqual([]);
  });
});
