/**
 * What else nexus does with the app's Claude and Codex tabs, as their own
 * buttons do: a message's timing and files, a held or unread message taken
 * back or changed, a rewind, a fork, a call sent to the background, a task
 * stopped, Remote Control, slash commands, past conversations, the side
 * panel; and a terminal's Claude Code answered.
 */
import { describe, expect, test } from "bun:test";
import type { ChatPanel } from "../../../../packages/remote-protocol/src";
import { CLI_COMMANDS } from "../../../../src/main/features/cli/commands";
import { panelText } from "../../../../src/main/features/cli/commands/chat-control";
import { runCli } from "../../../../src/main/features/cli/registry";
import type { CliChatInfo, CliTabInfo } from "../../../../src/shared/cli/ui";
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
    const codex = withChat({}, "codex");
    expect((await nexus(codex, ["chat", "rewind", "eeee", "0"])).stderr).toContain(
      "only a Claude tab can rewind",
    );
  });
});

describe("chat fork", () => {
  test("forks all of it, or from a message, printing the message to send again", async () => {
    const app = withChat();
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
    ["dedicated on", ["remote-control", "eeee", "on"], true],
    ["dedicated off", ["remote-control", "eeee", "off"], false],
    ["slash on", ["command", "eeee", "remote-control"], true],
    ["slash off", ["command", "eeee", "remote-control"], false],
    ["slash alias on", ["command", "eeee", "/RC"], true],
    ["slash alias off", ["command", "eeee", "/RC"], false],
  ] as const)("%s follows the workspace policy", async (_name, argv, enabled) => {
    const app = withChat();
    app.uiAnswers.set("chat.panel", {
      remoteControl: { available: true, enabled: !enabled, url: "https://claude.ai/code/s1" },
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
    const kind = enabled ? "chatRemoteControlOn" : "chatRemoteControlOff";
    expect(app.asked.map((r) => r.change.kind)).toEqual([kind, kind]);
    expect(calls(app, "chat.remoteControl")).toEqual(
      Array.from({ length: 3 }, () => ({ ...TARGET, enabled })),
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
