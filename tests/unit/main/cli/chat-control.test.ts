/**
 * What else nexus does with the app's Claude and Codex tabs, as their own
 * buttons do: a message's timing and files, a held or unread message taken
 * back or changed, a rewind, a fork, a call sent to the background, a task
 * stopped, Remote Control, slash commands, past conversations, the side
 * panel; and a terminal's Claude Code answered.
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatPanel } from "../../../../packages/remote-protocol/src";
import { CLI_COMMANDS } from "../../../../src/main/features/cli/commands";
import { panelText } from "../../../../src/main/features/cli/commands/chat-control";
import { runCli } from "../../../../src/main/features/cli/registry";
import { existingChatController } from "../../../../src/renderer/services/chat/claude/controller";
import { chatKey, emptyTabState, useChatStore } from "../../../../src/renderer/services/chat/store";
import { useTabsStore } from "../../../../src/renderer/state/stores/tabs";
import type { CliChatInfo, CliTabInfo, CliUiOps } from "../../../../src/shared/cli/ui";
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
const TARGET = { workspaceId: APP, tabId: CHAT_TAB };

async function nexus(
  app: FakeApp,
  argv: string[],
  caller = { workspaceId: APP, tabId: SHELL_TAB },
  stdin?: string,
) {
  return runCli(CLI_COMMANDS, contextFor(app, argv, caller, stdin === undefined ? {} : { stdin }));
}

function calls(app: FakeApp, op: string): unknown[] {
  return app.uiCalls.filter((c) => c.op === op).map((c) => c.args);
}

/** An app with a tab "Fix the login" (Claude unless `type`) in "app", standing as `info` says. */
function withChat(info: Partial<CliChatInfo> = {}, type: "claude" | "codex" = "claude"): FakeApp {
  const app = fakeApp();
  const chat: CliTabInfo = {
    id: CHAT_TAB,
    type,
    title: "Fix the login",
    groupId: "g1",
    shown: false,
  };
  app.tabs[APP]?.push(chat);
  app.chats.set(CHAT_TAB, {
    info: { agent: type, state: "working", ...info },
    entries: [
      { i: 0, role: "user", text: "Fix the login redirect" },
      { i: 1, role: "agent", text: "Looking at the router." },
      { i: 2, role: "tool", text: "Bash npm test", toolUseId: "toolu_1", status: "running" },
      { i: 3, role: "user", text: "Also the logout", status: "unread" },
    ],
    tools: [
      {
        i: 2,
        toolUseId: "toolu_1",
        name: "Bash",
        status: "running",
        input: { command: "npm test" },
      },
    ],
  });
  // Entries 0 and 3 are the user's messages (items u0, u3); 1 and 2 the agent's (a1).
  app.uiAnswers.set("chat.entryItem", (args) => {
    const { i } = args as { i: number };
    if (i === 0) return { itemKey: "u0", kind: "user", text: "Fix the login redirect" };
    if (i === 3) return { itemKey: "u3", kind: "user", text: "Also the logout" };
    if (i === 1 || i === 2) return { itemKey: "a1", kind: "assistant" };
    throw new Error(`no message #${i} in that tab`);
  });
  return app;
}

describe("chat send", () => {
  test("--wait follows the returned submission even while the previous turn asks", async () => {
    const app = withChat({ state: "asking", message: "an earlier question" });
    app.uiAnswers.set("chat.send", { heldId: "queued", submissionId: "queued" });
    let looked = 0;
    app.uiAnswers.set("chat.state", (args) => {
      if ((args as { submissionId?: string }).submissionId !== "queued") {
        return { agent: "claude", state: "asking", message: "an earlier question" };
      }
      return ++looked < 2
        ? { agent: "claude", state: "working" }
        : { agent: "claude", state: "idle", message: "the queued prompt's answer" };
    });
    const result = await nexus(app, ["chat", "send", "eeee", "--wait", "--after", "next"]);
    expect(result.stdout).toContain("the queued prompt's answer");
    expect(looked).toBe(2);
  });

  test("--after holds it for after the turn and prints its id; --now goes into the turn", async () => {
    const app = withChat();
    app.uiAnswers.set("chat.send", { heldId: "r7" });
    const held = await nexus(app, ["chat", "send", "eeee", "--after", "then", "this"]);
    expect(held.stdout).toBe("Held for after the turn of Fix the login (eeeeeeee), as r7.\n");
    app.uiAnswers.set("chat.send", {});
    await nexus(app, ["chat", "send", "eeee", "--now", "stop that"]);
    const sent = calls(app, "chat.send") as Array<{ text: string; when?: string }>;
    expect(sent.map((s) => [s.text, s.when])).toEqual([
      ["then this", "after"],
      ["stop that", "now"],
    ]);
    const both = await nexus(app, ["chat", "send", "eeee", "--now", "--after", "x"]);
    expect(both.stderr).toContain("--now or --after, not both");
  });

  test("--now with no text has a Claude tab read its unread messages now", async () => {
    const app = withChat();
    const result = await nexus(app, ["chat", "send", "eeee", "--now"]);
    expect(result.stdout).toBe("Had Fix the login (eeeeeeee) read its messages now.\n");
    expect(calls(app, "chat.hurry")).toEqual([TARGET]);
    expect(calls(app, "chat.send")).toEqual([]);
    const codex = withChat({}, "codex");
    expect((await nexus(codex, ["chat", "send", "eeee", "--now"])).stderr).toContain(
      "only a Claude tab",
    );
  });

  test("--file attaches files of the caller's computer, read where its terminal runs", async () => {
    const app = withChat();
    READABLE["/w/app/notes/plan.md"] = "# Plan";
    READABLE["/w/app/shot.png"] = "png";
    const result = await nexus(app, [
      "chat",
      "send",
      "eeee",
      "see these",
      "--file",
      "notes/plan.md",
      "--file=shot.png",
    ]);
    expect(result.exitCode).toBe(0);
    const [sent] = calls(app, "chat.send") as Array<{ files?: { name: string; data: string }[] }>;
    expect(sent?.files).toEqual([
      { name: "plan.md", data: Buffer.from("# Plan").toString("base64") },
      { name: "shot.png", data: Buffer.from("png").toString("base64") },
    ]);
    const alone = await nexus(app, ["chat", "send", "eeee", "--file", "shot.png"]);
    expect(alone.exitCode).toBe(0);
    const missing = await nexus(app, ["chat", "send", "eeee", "x", "--file", "gone.txt"]);
    expect(missing.stderr).toContain("no file /w/app/gone.txt");
  });

  test("another workspace's tab is asked about with the files named", async () => {
    const app = withChat();
    const chat = app.tabs[APP]?.pop() as CliTabInfo;
    app.tabs[API]?.push(chat);
    READABLE["/w/app/a.txt"] = "a";
    await nexus(app, ["chat", "send", "eeee", "hi", "--file", "a.txt", "--workspace", "api"]);
    expect(app.asked[0]?.change).toEqual({
      kind: "chatInput",
      detail: "Fix the login",
      body: "hi\n\n[a.txt]",
    });
  });
});

describe("chat unsend and chat edit", () => {
  test("a held message is taken back by its id, its text printed, or changed", async () => {
    const app = withChat();
    app.uiAnswers.set("chat.unqueue", { text: "then this" });
    const back = await nexus(app, ["chat", "unsend", "eeee", "r7"]);
    expect(back.stdout).toBe(
      "Took back the held message from Fix the login (eeeeeeee):\nthen this\n",
    );
    expect(calls(app, "chat.unqueue")).toEqual([{ ...TARGET, id: "r7" }]);
    await nexus(app, ["chat", "edit", "eeee", "r8", "-"], undefined, "new text\n");
    expect(calls(app, "chat.editHeld")).toEqual([{ ...TARGET, id: "r8", text: "new text" }]);
  });

  test("an unread message is taken back by its #, only while unread", async () => {
    const app = withChat();
    app.uiAnswers.set("chat.withdraw", { withdrawn: true });
    const back = await nexus(app, ["chat", "unsend", "eeee", "#3"]);
    expect(back.stdout).toBe("Took back #3 from Fix the login (eeeeeeee).\n");
    expect(calls(app, "chat.withdraw")).toEqual([{ ...TARGET, itemKey: "u3" }]);
    app.uiAnswers.set("chat.withdraw", { withdrawn: false });
    const late = await nexus(app, ["chat", "unsend", "eeee", "3"]);
    expect([late.exitCode, late.stdout]).toEqual([1, "#3 was read already; it stays.\n"]);
    const notUsers = await nexus(app, ["chat", "unsend", "eeee", "1"]);
    expect(notUsers.stderr).toContain("#1 is not a message sent to it");
  });
});

describe("chat rewind", () => {
  test("asks the user each time, showing the message and the files it undoes", async () => {
    const app = withChat({ state: "idle" });
    app.uiAnswers.set("chat.rewindPreview", {
      canRewind: true,
      filesChanged: ["/w/app/src/router.ts"],
      insertions: 4,
      deletions: 1,
    });
    app.answers.push("once");
    const result = await nexus(app, ["chat", "rewind", "eeee", "0", "--files"]);
    expect(result.stdout).toBe(
      "Rewound Fix the login (eeeeeeee) to before #0 and undid 1 file (+4 -1):\n  /w/app/src/router.ts.\n",
    );
    expect(app.asked[0]?.change).toEqual({
      kind: "chatRewindFiles",
      detail: '"Fix the login" (#0)',
      body: "Fix the login redirect\n\n1 file (+4 -1):\n  /w/app/src/router.ts",
    });
    expect(calls(app, "chat.rewind")).toEqual([{ ...TARGET, itemKey: "u0", files: true }]);
  });

  test("--preview only tells; nothing is rewound the user did not allow, nor to an answer", async () => {
    const app = withChat({ state: "idle" });
    app.uiAnswers.set("chat.rewindPreview", {
      canRewind: true,
      filesChanged: [],
      insertions: 0,
      deletions: 0,
    });
    const preview = await nexus(app, ["chat", "rewind", "eeee", "0", "--preview"]);
    expect(preview.stdout).toBe(
      "Rewinding to before #0 with --files undoes no file changes to undo\n",
    );
    expect(app.asked).toEqual([]);
    const denied = await nexus(app, ["chat", "rewind", "eeee", "0"]);
    expect(denied.stderr).toBe("nexus: the user did not allow it\n");
    expect(app.asked[0]?.change.kind).toBe("chatRewind");
    expect(calls(app, "chat.rewind")).toEqual([]);
    const answer = await nexus(app, ["chat", "rewind", "eeee", "1"]);
    expect(answer.stderr).toContain("#1 is not a message sent to it");
  });

  test("Codex previews and rewinds a turn with approval and refuses restoring files", async () => {
    const app = withChat({ state: "idle" }, "codex");
    app.uiAnswers.set("chat.rewindPreview", {
      canRewind: false,
      filesChanged: [],
      insertions: 0,
      deletions: 0,
    });
    const rewind = ["chat", "rewind", "eeee", "0"];
    expect((await nexus(app, [...rewind, "--files"])).stderr).toContain(
      "Codex conversation rewind cannot restore files",
    );
    expect((await nexus(app, [...rewind, "--preview"])).stdout).toContain(
      "Codex can rewind the conversation to before #0",
    );
    expect(app.asked).toEqual([]);
    expect((await nexus(app, rewind)).exitCode).toBe(1);
    expect(calls(app, "chat.rewind")).toEqual([]);
    app.answers.push("once");
    expect((await nexus(app, rewind)).exitCode).toBe(0);
    expect(app.asked.map((request) => request.change.kind)).toEqual(["chatRewind", "chatRewind"]);
    expect(calls(app, "chat.rewind")).toEqual([{ ...TARGET, itemKey: "u0", files: false }]);
  });
});

describe("chat fork", () => {
  test.each(["claude", "codex"] as const)("%s forks all or from a message", async (agent) => {
    const app = withChat({}, agent);
    app.uiAnswers.set("chat.fork", { tabId: NEW_TAB });
    const all = await nexus(app, ["chat", "fork", "eeee"]);
    expect(all.stdout).toBe("Forked Fix the login (eeeeeeee) into tab cccccccc.\n");
    app.uiAnswers.set("chat.fork", { tabId: NEW_TAB, draft: "Also the logout" });
    const from = await nexus(app, ["chat", "fork", "eeee", "3"]);
    expect(from.stdout).toContain("Its message was not sent");
    expect(from.stdout).toEndWith("\nAlso the logout\n");
    expect(calls(app, "chat.fork")).toEqual([TARGET, { ...TARGET, itemKey: "u3" }]);
  });
});

describe("chat background, stop-task and remote-control", () => {
  test("a running call goes to the background by its #, a task is stopped by its id", async () => {
    const app = withChat();
    const sent = await nexus(app, ["chat", "background", "eeee", "2"]);
    expect(sent.stdout).toBe("Sent Bash (#2) of Fix the login (eeeeeeee) to the background.\n");
    expect(calls(app, "chat.background")).toEqual([{ ...TARGET, toolUseId: "toolu_1" }]);
    await nexus(app, ["chat", "stop-task", "eeee", "b12"]);
    expect(calls(app, "chat.stopTask")).toEqual([{ ...TARGET, taskId: "b12" }]);
  });

  test.each([
    [
      "off succeeds without an eligible account",
      "off",
      false,
      {
        exitCode: 0,
        stdout: "Turned Remote Control off for Fix the login (eeeeeeee).\n",
      },
    ],
    [
      "on requires an eligible account",
      "on",
      false,
      {
        exitCode: 1,
        stderr: "nexus: its account cannot turn on Remote Control\n",
      },
    ],
    [
      "off requires initialization to check availability",
      "off",
      undefined,
      {
        exitCode: 1,
        stderr: "nexus: its program is not ready\n",
      },
    ],
  ] as const)("%s", async (_name, turn, available, expected) => {
    const app = withChat();
    const tabs = useTabsStore.getState().byWorkspace;
    const chats = useChatStore.getState().tabs;
    const globals = globalThis as Record<string, unknown>;
    const savedWindow = globals.window;
    globals.window = { ...(savedWindow as object), ipc: { listen: () => () => {} } };
    const tab = emptyTabState();
    if (available !== undefined) {
      tab.phase = "ready";
      tab.model.process = "running";
      tab.model.init = { commands: [], models: [], remoteControl: available };
    }
    useChatStore.setState({ tabs: { ...chats, [chatKey(APP, CHAT_TAB)]: tab } });
    useTabsStore.setState({
      byWorkspace: {
        ...tabs,
        [APP]: {
          ...tabs[APP],
          [CHAT_TAB]: {
            id: CHAT_TAB,
            type: "claude",
            title: "Fix the login",
            defaultTitle: "Fix the login",
            isPreview: false,
            isPinned: false,
            props: { cwd: "/w/app" },
          },
        },
      },
    });
    try {
      const { chatHandlers } = await import("../../../../src/renderer/services/cli/chat-actions");
      app.uiAnswers.set("chat.remoteControl", (args) =>
        chatHandlers["chat.remoteControl"](args as CliUiOps["chat.remoteControl"]["args"]),
      );
      expect(await nexus(app, ["chat", "remote-control", "eeee", turn])).toMatchObject(expected);
      expect(app.asked).toHaveLength(0);
    } finally {
      existingChatController(APP, CHAT_TAB)?.dispose();
      useChatStore.setState({ tabs: chats });
      useTabsStore.setState({ byWorkspace: tabs });
      globals.window = savedWindow;
    }
  });

  test.each([
    ["dedicated on", ["remote-control", "eeee", "on"], true],
    ["dedicated off", ["remote-control", "eeee", "off"], false],
    ["slash on", ["command", "eeee", "remote-control"], true],
    ["slash off", ["command", "eeee", "remote-control"], false],
    ["slash alias on", ["command", "eeee", "/RC"], true],
    ["slash alias off", ["command", "eeee", "/RC"], false],
    ["send alias", ["send", "eeee", "/RC"], false],
    ["send command with args", ["send", "eeee", "/remote-control", "ignored"], true],
  ] as const)("%s follows the workspace policy", async (_name, argv, enabled) => {
    const app = withChat();
    app.uiAnswers.set("chat.remoteControl", {
      enabled,
      ...(enabled ? { url: "https://claude.ai/code/s1" } : {}),
    });
    const local = await nexus(app, ["chat", ...argv]);
    expect(local.stdout).toContain(`Turned Remote Control ${enabled ? "on" : "off"}`);
    expect(app.asked).toHaveLength(0);

    const remoteWorkspace = ["chat", ...argv, "--workspace", APP];
    const caller = { workspaceId: API, tabId: SHELL_TAB };
    app.settings.crossWorkspace = "deny";
    expect((await nexus(app, remoteWorkspace, caller)).exitCode).toBe(1);
    app.settings.crossWorkspace = "ask";
    expect((await nexus(app, remoteWorkspace, caller)).exitCode).toBe(1);
    app.answers.push("once");
    expect((await nexus(app, remoteWorkspace, caller)).exitCode).toBe(0);
    app.settings.crossWorkspace = "allow";
    expect((await nexus(app, remoteWorkspace, caller)).exitCode).toBe(0);
    const explicit = argv[0] === "remote-control";
    const kind = explicit
      ? enabled
        ? "chatRemoteControlOn"
        : "chatRemoteControlOff"
      : "chatRemoteControlToggle";
    expect(app.asked.map((r) => r.change.kind)).toEqual([kind, kind]);
    expect(calls(app, "chat.remoteControl")).toEqual(
      Array.from({ length: 3 }, () => ({ ...TARGET, ...(explicit ? { enabled } : {}) })),
    );
    expect(calls(app, "chat.command")).toEqual([]);
  });
});

describe("chat commands and chat command", () => {
  const COMMANDS = {
    commands: [
      { name: "compact", description: "Compact the conversation", runs: "send" },
      { name: "plan", description: "Plan first", runs: "command", args: "<task>" },
      { name: "model", description: "Pick a model", runs: "settings", sets: "model" },
    ],
  };

  test("uses the desktop composer's case-insensitive command names and aliases", async () => {
    const app = withChat();
    app.uiAnswers.set("chat.commands", {
      commands: [
        { name: "new", aliases: ["clear"], description: "New conversation", runs: "command" },
        { name: "plan", description: "Plan mode", runs: "command" },
      ],
    });
    app.uiAnswers.set("chat.command", {});
    await nexus(app, ["chat", "command", "eeee", "/CLEAR"]);
    await nexus(app, ["chat", "command", "eeee", "/PLAN"]);
    expect(calls(app, "chat.command")).toEqual([
      { ...TARGET, name: "new" },
      { ...TARGET, name: "plan" },
    ]);
  });

  test("lists them; the agent's own goes as a message, the app's own runs", async () => {
    const app = withChat();
    app.uiAnswers.set("chat.commands", COMMANDS);
    const listed = await nexus(app, ["chat", "commands", "eeee"]);
    expect(listed.stdout).toContain("/plan <task>  Plan first  (chat command)\n");
    await nexus(app, ["chat", "command", "eeee", "/compact"]);
    expect((calls(app, "chat.send") as Array<{ text: string }>).map((s) => s.text)).toEqual([
      "/compact",
    ]);
    app.uiAnswers.set("chat.command", { message: "Planning." });
    const ran = await nexus(app, ["chat", "command", "eeee", "plan", "the", "login"]);
    expect(ran.stdout).toBe("Ran /plan the login in Fix the login (eeeeeeee).\nPlanning.\n");
    expect(calls(app, "chat.command")).toEqual([{ ...TARGET, name: "plan", args: "the login" }]);
    const setting = await nexus(app, ["chat", "command", "eeee", "model"]);
    expect(setting.stderr).toContain("/model is set with chat set --model");
    const none = await nexus(app, ["chat", "command", "eeee", "nope"]);
    expect(none.stderr).toContain("has no command /nope");
  });
});

describe("chat history and chat resume", () => {
  test("lists the past conversations, and goes on with one by the start of its id", async () => {
    const app = withChat();
    const now = app.time.now;
    app.uiAnswers.set("chat.history", {
      sessions: [
        {
          sessionId: "5f2a-1",
          title: "Login fix",
          at: now - 3 * 86_400_000,
          cwd: "/w/app",
          profile: "default",
        },
        {
          sessionId: "71bc-2",
          title: "",
          firstPrompt: "Add tests",
          at: now - 60_000,
          cwd: "/w/app",
          profile: "Work",
          gitBranch: "tests",
        },
      ],
    });
    const listed = await nexus(app, ["chat", "history", "login"]);
    expect(listed.stdout).toBe(
      "5f2a-1  Login fix  (3d ago)\n71bc-2  Add tests  (1m ago, profile Work, on tests)\n",
    );
    expect(calls(app, "chat.history")[0]).toEqual({
      workspaceId: APP,
      agent: "claude",
      query: "login",
      limit: 20,
    });
    app.uiAnswers.set("chat.resume", { tabId: NEW_TAB });
    const resumed = await nexus(app, ["chat", "resume", "71bc"]);
    expect(resumed.stdout).toBe('Went on with "Add tests" in tab cccccccc.\n');
    expect(calls(app, "chat.resume")).toEqual([
      { workspaceId: APP, agent: "claude", sessionId: "71bc-2" },
    ]);
    expect((await nexus(app, ["chat", "resume", "9"])).stderr).toContain(
      "no past Claude conversation 9",
    );
  });
});

describe("chat panel", () => {
  test("prints what the panel shows, its parts that have something", () => {
    const panel: ChatPanel = {
      todos: [
        { content: "Read the router", status: "completed" },
        { content: "Fix the redirect", status: "in_progress" },
      ],
      tasks: [{ taskId: "b12", type: "local_bash", description: "npm run dev", status: "running" }],
      agents: [],
      changedFiles: [{ path: "/w/app/src/router.ts", added: 4, removed: 1 }],
      context: { usedTokens: 50_000, maxTokens: 200_000 },
      planLimits: [{ kind: "session", percent: 34, resetsAt: 1_000 + 2 * 3_600_000 }],
      goal: null,
      held: [{ id: "r7", text: "then this", images: 1 }],
    };
    expect(panelText("Fix the login (eeeeeeee)", panel, 1_000)).toBe(
      [
        "Fix the login (eeeeeeee)",
        "",
        "To-dos:\n  [x] Read the router\n  [>] Fix the redirect",
        "",
        "Tasks (chat stop-task <tab> <id>):\n  b12  running  npm run dev",
        "",
        "Changed files:\n  /w/app/src/router.ts  +4 -1",
        "",
        "Context: 50,000 of 200,000 tokens (25%)\nPlan limits: session 34%, resets in 2h",
        "",
        "Held messages (chat unsend / chat edit <tab> <id>):\n  r7  then this [1 image]",
      ].join("\n"),
    );
  });

  test("leaves out the account the tab's program is signed in with", async () => {
    const app = withChat();
    app.uiAnswers.set("chat.panel", {
      todos: [],
      tasks: [],
      agents: [],
      changedFiles: [],
      context: null,
      goal: null,
      session: { id: "s1", account: "someone · org · Max" },
    });
    const json = JSON.parse((await nexus(app, ["chat", "panel", "eeee", "--json"])).stdout);
    expect(json.session).toEqual({ id: "s1" });
  });
});

describe("chat answer for a terminal's Claude Code", () => {
  test("answers the request it holds, as the user allows, and can stop its turn", async () => {
    const app = withChat();
    app.terminalAsks.set(CLAUDE_TAB, [
      { id: "h1", tool: "Bash", target: "rm -rf build", always: [], since: 5 },
    ]);
    app.answers.push("once");
    const result = await nexus(app, ["chat", "answer", "✳ Claude Code", "deny", "--stop"]);
    expect(result.stdout).toBe("Denied Bash rm -rf build in ✳ Claude Code.\n");
    expect(app.asked[0]?.change).toEqual({
      kind: "permissionDeny",
      detail: "Bash (✳ Claude Code)",
      body: "Bash rm -rf build",
    });
    expect(app.terminalAnswered).toEqual([{ tabId: CLAUDE_TAB, askId: "h1", answer: "denyStop" }]);
    const none = await nexus(app, [
      "chat",
      "answer",
      "aaaaaaaa-0000-4000-8000-000000000002",
      "allow",
    ]);
    expect(none.stderr).toContain("waits on no permission request");
    const message = await nexus(app, [
      "chat",
      "answer",
      "✳ Claude Code",
      "deny",
      "--message",
      "no",
    ]);
    expect(message.stderr).toContain("--message goes to a Claude or Codex tab");
  });
});

test("chat profiles exposes selectable names and the workspace default, with portable paths", async () => {
  const app = withChat();
  app.uiAnswers.set("chat.profiles", {
    profiles: [
      {
        id: "work",
        name: "Work",
        agent: "codex",
        workspaceDefault: true,
        path: "~/.codex-work",
        account: "hidden",
        token: "hidden",
      },
    ],
  });
  const result = await nexus(app, [
    "chat",
    "profiles",
    "--workspace",
    API,
    "--agent",
    "codex",
    "--json",
  ]);
  expect(JSON.parse(result.stdout)).toEqual({
    workspaceId: API,
    profiles: [
      { id: "work", name: "Work", agent: "codex", workspaceDefault: true, path: "~/.codex-work" },
    ],
  });
  expect(calls(app, "chat.profiles")).toEqual([{ workspaceId: API, agent: "codex" }]);
  expect(app.asked).toEqual([]);
});

describe("chat usage", () => {
  const now = Date.parse("2026-11-22T12:00:00Z");
  const fetchedAt = now - 5_000;
  const result = {
    profiles: [
      {
        id: "work",
        name: "Work",
        agent: "claude",
        status: "stale",
        fetchedAt,
        limits: [
          {
            kind: "session",
            percent: 18.5,
            fetchedAt: now - 12_000,
            resetsAt: now + (4 * 60 + 55) * 60_000,
            stale: false,
          },
          {
            kind: "weekly",
            percent: 50,
            fetchedAt,
            resetsAt: now + (4 * 24 + 3) * 3_600_000,
            stale: false,
          },
          {
            kind: "weekly_scoped",
            scope: "Sonnet",
            percent: 80,
            fetchedAt,
            resetsAt: now - 5 * 60_000,
            stale: true,
          },
        ],
      },
      {
        id: "gateway",
        name: "Gateway",
        agent: "codex",
        status: "not-subscription",
        limits: [],
      },
    ],
  } satisfies CliUiOps["chat.usage"]["result"];

  test("prints relative times in text and Unix milliseconds in JSON and JSONL", async () => {
    const app = fakeApp(now);
    app.uiAnswers.set("chat.usage", result);
    const text = await nexus(app, ["chat", "usage"]);
    expect(text.stdout).toBe(
      "claude · Work (work) · Stale · Observed 5s ago\n" +
        "  5-hour session 18.5% used · Resets in 4h 55m · Observed 12s ago\n" +
        "  Weekly 50% used · Resets in 4d 3h\n" +
        "  Weekly (Sonnet) 80% used · Reset 5m ago · Stale\n\n" +
        "codex · Gateway (gateway) · No subscription\n",
    );
    const json = await nexus(app, ["chat", "usage", "--json"]);
    expect(JSON.parse(json.stdout)).toEqual(result);
    const jsonl = await nexus(app, ["chat", "usage", "--jsonl"]);
    expect(
      jsonl.stdout
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    ).toEqual(result.profiles);
    expect(app.uiCalls.map(({ op }) => op)).toEqual(["chat.usage", "chat.usage", "chat.usage"]);
    const help = await nexus(app, ["help", "chat", "usage"]);
    expect(help.stdout).toContain("--refresh");
  });

  test("sends profile filters to a peer that serves usage", async () => {
    const app = fakeApp();
    const device = { id: "55555555-5555-4555-8555-555555555555", name: "Mac mini" };
    const peer = {
      ...device,
      platform: "darwin",
      online: true,
      self: false,
      schema: "0.17.0",
    };
    app.peers.devices = [{ ...peer, serves: ["agents", "profiles.usage"] }];
    app.peers.answer = async () => result;
    const args = [
      "chat",
      "usage",
      "--device",
      device.name,
      "--agent",
      "claude",
      "--profile",
      "Work",
      "--refresh",
      "--json",
    ];
    const filters = { agent: "claude", profile: "Work", refresh: true };
    const json = await nexus(app, args);
    expect(JSON.parse(json.stdout)).toEqual({ device, ...filters, ...result });
    expect(app.peers.requests).toEqual([
      {
        deviceId: device.id,
        method: "profiles.usage",
        params: { ...filters, from: { kind: "terminal", workspaceId: APP, tabId: SHELL_TAB } },
        timeoutMs: 125_000,
      },
    ]);

    app.peers.devices = [{ ...peer, schema: "0.16.0", serves: ["agents"] }];
    expect((await nexus(app, args)).stderr).toContain('Update NexusCode on "Mac mini"');
    expect(app.peers.requests).toHaveLength(1);
  });
});

test("an image save collision does not print its destination path", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cli-image-"));
  try {
    const out = join(dir, "private-destination.png");
    await writeFile(out, "existing");
    const app = withChat();
    app.uiAnswers.set("chat.image", { mediaType: "image/png", data: "YQ==" });
    const ctx = contextFor(
      app,
      ["chat", "image", "eeee", "--tool", "t1", "--out", out],
      undefined,
      {
        cwd: dir,
      },
    );
    const result = await runCli(CLI_COMMANDS, ctx);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("nexus: image output already exists\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
