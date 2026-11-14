/**
 * nexus reaching past its own workspace and waiting on other terminals:
 * the user's leave for changes elsewhere, and terminal wait and send --wait.
 */
import { describe, expect, test } from "bun:test";
import { CLI_COMMANDS } from "../../../../src/main/features/cli/commands";
import { runCli } from "../../../../src/main/features/cli/registry";
import type { AgentRun } from "../../../../src/shared/claude/activity";
import type { WorkspaceMeta } from "../../../../src/shared/types/workspace";
import {
  API,
  APP,
  CLAUDE_TAB,
  CODEX_TAB,
  contextFor,
  type FakeApp,
  FIX,
  fakeApp,
  NEW_TAB,
  SHELL_TAB,
} from "./fake-services";

const SERVER_TAB = "aaaaaaaa-0000-4000-8000-000000000009";

async function nexus(app: FakeApp, argv: string[]) {
  return runCli(CLI_COMMANDS, contextFor(app, argv));
}

describe("changing another workspace", () => {
  const argv = ["terminal", "send", "codex", "go on", "--workspace", "api"];

  test("asks the user, and goes ahead when allowed once", async () => {
    const app = fakeApp();
    app.answers.push("once");
    const result = await nexus(app, argv);
    expect(result.exitCode).toBe(0);
    expect(app.asked).toEqual([
      {
        fromWorkspaceId: APP,
        fromTabId: SHELL_TAB,
        toWorkspaceId: API,
        // What would be typed, Enter and all, shown whole.
        change: { kind: "terminalInput", detail: "codex", body: "go on\n" },
      },
    ]);
    expect(app.uiCalls.at(-1)).toMatchObject({ op: "terminal.input", args: { tabId: CODEX_TAB } });
  });

  test("closing a terminal there says it is a terminal's, for who may answer it", async () => {
    const app = fakeApp();
    app.answers.push("once");
    await nexus(app, ["tab", "close", "codex", "--workspace", "api"]);
    expect(app.asked[0]?.change).toEqual({ kind: "tabClose", detail: "codex", terminal: true });
  });

  test("asks again after once, not after until-restart, for that kind of change alone", async () => {
    const app = fakeApp();
    const rename = ["tab", "rename", "codex", "x", "--workspace", "api"];
    app.answers.push("once", "session");
    await nexus(app, rename);
    await nexus(app, rename);
    await nexus(app, rename);
    expect(app.asked).toHaveLength(2);
    // Renaming its tabs says nothing of closing them.
    await nexus(app, ["tab", "close", "codex", "--workspace", "api"]);
    expect(app.asked.map((r) => r.change.kind)).toEqual(["tabRename", "tabRename", "tabClose"]);
  });

  test("asks each time before typing, running or sending, whatever was answered before", async () => {
    const app = fakeApp();
    app.answers.push("session", "session", "session", "session");
    await nexus(app, argv);
    await nexus(app, argv);
    await nexus(app, ["terminal", "key", "codex", "ctrl-c", "--workspace", "api"]);
    await nexus(app, ["terminal", "new", "--command", "make deploy", "--workspace", "api"]);
    expect(app.asked.map((r) => r.change)).toEqual([
      { kind: "terminalInput", detail: "codex", body: "go on\n" },
      { kind: "terminalInput", detail: "codex", body: "go on\n" },
      { kind: "terminalInput", detail: "codex", body: "ctrl-c" },
      { kind: "terminalNew", body: "make deploy" },
    ]);
    // A new terminal with no command is not: until restart holds for it.
    app.answers.push("session");
    await nexus(app, ["terminal", "new", "--workspace", "api"]);
    await nexus(app, ["terminal", "new", "--workspace", "api"]);
    expect(app.asked.slice(4).map((r) => r.change)).toEqual([{ kind: "terminalNew" }]);
  });

  test.each([
    ["the user turns it down", "deny", "nexus: the user did not allow it\n"],
    [
      "the user does not answer",
      "timeout",
      "nexus: the user did not answer in time; nothing was changed\n",
    ],
  ] as const)("changes nothing when %s", async (_label, answer, stderr) => {
    const app = fakeApp();
    app.answers.push(answer);
    const result = await nexus(app, argv);
    expect(result.stderr).toBe(stderr);
    expect(app.uiCalls.some((c) => c.op === "terminal.input")).toBe(false);
  });

  test("follows the setting without asking when it says allow or deny", async () => {
    const app = fakeApp();
    app.settings.crossWorkspace = "allow";
    expect((await nexus(app, argv)).exitCode).toBe(0);
    app.settings.crossWorkspace = "deny";
    expect((await nexus(app, argv)).stderr).toBe(
      "nexus: changing other workspaces is turned off in NexusCode's settings (Agents)\n",
    );
    expect(app.asked).toHaveLength(0);
  });

  test("never asks for its own workspace, nor for reading another", async () => {
    const app = fakeApp();
    await nexus(app, ["open", "index.ts"]);
    await nexus(app, ["terminal", "read", "codex", "--workspace", "api"]);
    await nexus(app, ["workspace", "switch", "api"]);
    expect(app.asked).toHaveLength(0);
  });

  // Every command that takes --workspace, as run on a busy "api" with the user
  // saying no: one that changes it asks first and changes nothing, one that
  // reads it runs through without asking. A new command fails until it is here.
  const CHANGES = `
    worktree new feat | worktree remove api-feat | terminal new | terminal send codex hi
    terminal key codex enter | tab close codex | tab save main.go | tab revert main.go
    tab move codex 2 | tab rename codex x | tab pin codex | tab unpin codex
    layout split codex right | layout resize 1 50 | layout even | layout close 1
    chat new | chat send eeee hi | chat interrupt eeee | chat set eeee --effort high
    open main.go | diff main.go | show | port forward 3000 | port unforward 3000
    agent stop 8f7b --tab codex | browser open localhost:3000 | browser goto localhost:3000/x
    browser back | browser forward | browser reload | browser click e1 | browser hover e1
    browser drag e1 e2 | browser scroll down | browser fill e1 x | browser type x
    browser press Enter | browser upload e1 index.ts | browser eval 1`;
  const READS = `
    worktree list | tab list | tab show codex | terminal list | terminal read codex
    terminal wait codex --match Working | session list | events | layout show | problems
    chat read eeee | chat tool eeee 2 | chat wait eeee | reveal main.go | port list
    view open codex | view split codex right | view move codex p1 | view remove codex
    panel list | panel show files | panel hide files | agent list --tab codex
    agent show 1a2b --tab codex | agent wait 1a2b --tab codex | browser list
    browser snapshot | browser inspect e1 | browser dialog | browser screenshot
    browser console | browser wait --text hi | browser pick | browser network
    note list | note read nmhz00cc | note path nmhz00cc`;
  /** What a command may do in "api" without asking: read it, show it, or arrange the window. */
  const LOOKS = new Set(
    `tabs.list tab.show terminal.read chat.state chat.read chat.tool events.read layout.get
    files.reveal problems.list agentView.get agentView.place agentView.remove panels.get
    panels.set page.snapshot page.inspect page.dialog page.screenshot page.console page.waitFor
    page.pick page.network`.split(/\s+/),
  );

  test("every command asks before it changes another workspace, and only then", async () => {
    const lines = (table: string) =>
      table
        .split(/[|\n]/)
        .map((line) => line.trim())
        .filter(Boolean);
    const paths = CLI_COMMANDS.filter((c) => c.flags?.workspace).map((c) => c.path.join(" "));
    const commandOf = (line: string) =>
      paths.filter((p) => `${line} `.startsWith(`${p} `)).sort((a, b) => b.length - a.length)[0];
    const runs = [
      ...lines(CHANGES).map((line) => ({ line, changes: true })),
      ...lines(READS).map((line) => ({ line, changes: false })),
    ];
    // chat answer is refused to a terminal outright; manager.test.ts covers who may answer.
    expect([...runs.map((r) => commandOf(r.line)), "chat answer"].sort()).toEqual(paths.sort());
    for (const { line, changes } of runs) {
      const app = apiAtWork();
      const forwards = JSON.stringify(app.forwarding.forwards);
      const result = await nexus(app, [...line.split(" "), "--workspace", "api"]);
      const made = [
        ...app.uiCalls.map((c) => c.op),
        ...app.browser.calls.map((c) => `page.${c.op}`),
        ...app.stops.map(() => "agent.stop"),
        ...(JSON.stringify(app.forwarding.forwards) === forwards ? [] : ["forwards"]),
      ].filter((op) => !LOOKS.has(op));
      expect({ line, asked: app.asked.length > 0, ran: result.exitCode === 0, made }).toEqual({
        line,
        asked: changes,
        ran: !changes,
        made: [],
      });
    }
  });
});

const CHAT_TAB = "eeeeeeee-0000-4000-8000-000000000008";
const WEB_TAB = "dddddddd-0000-4000-8000-000000000007";
const MAIN_TAB = "dddddddd-0000-4000-8000-00000000000a";

/**
 * "api" over SSH with something for every command: a Claude tab asking the
 * user, a browser and an unsaved editor in a second group, a worktree, a
 * forwarded port, and a claude -p run in its codex terminal beside one that
 * ended.
 */
function apiAtWork(): FakeApp {
  const app = fakeApp();
  const at = app.workspaces.findIndex((w) => w.id === API);
  const api = app.workspaces[at] as WorkspaceMeta;
  app.workspaces[at] = { ...api, location: { kind: "ssh", host: "box", remotePath: "/w/api" } };
  app.workspaces.push({
    ...api,
    id: "55555555-5555-4555-8555-555555555555",
    name: "api-feat",
    task: { parentId: API, branch: "feat", worktreePath: "/w/api-feat" },
  });
  app.notes[API] = [
    {
      id: "nmhz00cc0003",
      title: "API",
      createdAt: 0,
      updatedAt: 0,
      counts: { sketches: 0, files: 0, images: 0, todos: 0, todosDone: 0 },
      excerpt: "",
      doc: { type: "doc", content: [] },
      dir: "/data/notes/api/nmhz00cc0003",
    },
  ];
  app.tabs[API]?.push(
    { id: CHAT_TAB, type: "claude", title: "Fix the login", groupId: "g3", shown: false },
    {
      id: WEB_TAB,
      type: "browser",
      title: "Docs",
      url: "http://localhost:3000/",
      groupId: "g5",
      shown: false,
    },
    {
      id: MAIN_TAB,
      type: "editor",
      title: "main.go",
      filePath: "/w/api/main.go",
      groupId: "g5",
      shown: false,
      unsaved: true,
    },
  );
  const group = (id: string, tabIds: string[]) =>
    ({ kind: "group", id, tabIds, shownTabId: tabIds[0] ?? null }) as const;
  app.layouts[API] = {
    root: {
      kind: "split",
      id: "s3",
      direction: "columns",
      ratio: 0.5,
      first: group("g3", [CODEX_TAB, CHAT_TAB]),
      second: group("g5", [WEB_TAB, MAIN_TAB]),
    },
    activeGroupId: "g3",
  };
  app.chats.set(CHAT_TAB, {
    info: { agent: "claude", state: "asking", message: "asks: Bash ls" },
    entries: [{ i: 0, role: "user", text: "Fix the login" }],
    tools: [
      {
        i: 2,
        toolUseId: "toolu_1",
        name: "Read",
        status: "done",
        input: {},
        result: { text: "", isError: false },
      },
    ],
  });
  const run = (sessionId: string, extra: Partial<AgentRun> = {}): AgentRun => ({
    id: `print-${sessionId.slice(0, 8)}`,
    kind: "print",
    prompt: "Summarize the API",
    start: app.time.now - 9_000,
    state: "running",
    tools: [],
    toolCount: 0,
    failedCount: 0,
    toolsTold: true,
    sessionId,
    ...extra,
  });
  app.agents.set(`${API}:${CODEX_TAB}`, [
    run("8f7b63e3-a0e6-4b44-af95-03c2697fe716"),
    run("1a2b63e3-a0e6-4b44-af95-03c2697fe716", { state: "completed", end: app.time.now - 1_000 }),
  ]);
  app.forwarding.forwards[API] = [{ remotePort: 3000, localPort: 3000, active: true }];
  return app;
}

describe("terminal wait", () => {
  test("send --wait waits for the turn the text starts", async () => {
    const app = fakeApp();
    const key = `${APP}:${CLAUDE_TAB}`;
    const sentAt = app.time.now;
    app.time.onTick = (now) => {
      if (now - sentAt === 1_000) app.claude.set(key, { status: "running", since: now });
      if (now - sentAt === 4_000) {
        app.claude.set(key, { status: "completed", message: "Added the test.", since: now });
      }
    };
    const result = await nexus(app, ["terminal", "send", "✳ claude code", "add a test", "--wait"]);
    expect(result.stdout).toBe(
      "Sent to ✳ Claude Code (aaaaaaaa).\nClaude Code finished:\nAdded the test.\n",
    );
    expect(app.time.now - sentAt).toBe(4_000);
  });

  test("send --wait ends on a turn that stopped on an error", async () => {
    const app = fakeApp();
    const key = `${APP}:${CLAUDE_TAB}`;
    const sentAt = app.time.now;
    app.time.onTick = (now) => {
      if (now - sentAt === 1_000) app.claude.set(key, { status: "running", since: now });
      if (now - sentAt === 2_000) {
        app.claude.set(key, { status: "error", message: "API Error: 429", since: now });
      }
    };
    const result = await nexus(app, ["terminal", "send", "✳ claude code", "add a test", "--wait"]);
    expect(result.stdout).toBe(
      "Sent to ✳ Claude Code (aaaaaaaa).\nClaude Code stopped on an error: API Error: 429\n",
    );
  });

  test("send --wait tells a Claude Code that never starts a turn apart after a grace", async () => {
    const app = fakeApp();
    const sentAt = app.time.now;
    const result = await runCli(
      CLI_COMMANDS,
      contextFor(app, ["terminal", "send", "✳ claude code", "/help", "--wait", "--json"]),
    );
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ state: "notStarted" });
    expect(app.time.now - sentAt).toBe(10_000);
  });

  test("send --wait does not take the turn before it, seen by the user, as the answer", async () => {
    const app = fakeApp();
    const key = `${APP}:${CLAUDE_TAB}`;
    const sentAt = app.time.now;
    app.time.onTick = (now) => {
      // The user looks at the tab: the earlier turn's completed goes idle.
      if (now - sentAt === 500) app.claude.set(key, { status: "idle", since: now });
    };
    const result = await nexus(app, ["terminal", "send", "✳ claude code", "/help", "--wait"]);
    expect(result.stdout).toBe(
      "Sent to ✳ Claude Code (aaaaaaaa).\nClaude Code started no turn from the input.\n",
    );
    expect(app.time.now - sentAt).toBe(10_000);
  });

  test("send --wait takes a turn that ended between two looks", async () => {
    const app = fakeApp();
    const key = `${APP}:${CLAUDE_TAB}`;
    const sentAt = app.time.now;
    app.time.onTick = (now) => {
      if (now - sentAt === 1_000) {
        const entry = { message: "Fixed it.", since: now, turnStartedAt: now - 200 };
        app.claude.set(key, { status: "completed", ...entry });
      }
    };
    const result = await nexus(app, ["terminal", "send", "✳ claude code", "fix it", "--wait"]);
    expect(result.stdout).toBe(
      "Sent to ✳ Claude Code (aaaaaaaa).\nClaude Code finished:\nFixed it.\n",
    );
    expect(app.time.now - sentAt).toBe(1_000);
  });

  test("tells a waiting-for-permission Claude Code apart", async () => {
    const app = fakeApp();
    app.claude.set(`${APP}:${CLAUDE_TAB}`, {
      status: "permissionPending",
      message: "Bash(rm -rf build)",
      since: app.time.now,
    });
    const result = await runCli(
      CLI_COMMANDS,
      contextFor(app, ["terminal", "wait", "✳ claude code", "--json"]),
    );
    expect(JSON.parse(result.stdout)).toMatchObject({
      state: "permissionPending",
      message: "Bash(rm -rf build)",
    });
  });

  test("an agent told by its output is idle once it stops printing", async () => {
    const app = fakeApp();
    const start = app.time.now;
    app.activity.set(`${API}:${CODEX_TAB}`, { lastOutputAt: start });
    app.time.onTick = (now) => {
      if (now - start <= 3_000) app.activity.set(`${API}:${CODEX_TAB}`, { lastOutputAt: now });
    };
    const result = await nexus(app, ["terminal", "wait", "codex", "--workspace", "api"]);
    expect(result.stdout).toBe("codex has been quiet for a while.\n");
    expect(app.time.now - start).toBe(8_000);
  });

  test("waits no more once its client has gone, as one stopped with Ctrl-C", async () => {
    const app = fakeApp();
    const start = app.time.now;
    const stop = new AbortController();
    app.time.onTick = (now) => {
      // Codex keeps printing; the client goes after a second.
      app.activity.set(`${API}:${CODEX_TAB}`, { lastOutputAt: now });
      if (now - start >= 1_000) stop.abort();
    };
    const ctx = contextFor(app, ["terminal", "wait", "codex", "--workspace", "api"]);
    const result = await runCli(CLI_COMMANDS, { ...ctx, signal: stop.signal });
    expect(result.exitCode).toBe(124);
    expect(app.time.now - start).toBeLessThan(5_000);
    expect(app.waits.snapshot()).toEqual([]);
  });

  test("an agent's notification ends the wait", async () => {
    const app = fakeApp();
    const start = app.time.now;
    app.time.onTick = (now) => {
      if (now - start === 1_500) {
        app.activity.set(`${API}:${CODEX_TAB}`, {
          lastOutputAt: now,
          lastNotice: { body: "Agent turn complete", at: now },
        });
      }
    };
    const result = await nexus(app, ["terminal", "wait", "codex", "--workspace", "api"]);
    expect(result.stdout).toBe("codex says: Agent turn complete\n");
  });

  test("a shell is idle once its command gives back the prompt", async () => {
    const app = fakeApp();
    app.tabs[APP]?.push({
      id: SERVER_TAB,
      type: "terminal",
      title: "build",
      groupId: "g1",
      shown: false,
    });
    app.foreground.set(SERVER_TAB, "make");
    const start = app.time.now;
    app.time.onTick = (now) => {
      if (now - start === 2_500) app.foreground.set(SERVER_TAB, "-zsh");
    };
    const result = await nexus(app, ["terminal", "wait", "build"]);
    expect(result.stdout).toBe("build is back at its prompt.\n");
    expect(app.time.now - start).toBe(2_500);
  });
});

describe("terminal wait --match", () => {
  test("ends on the first line the pattern matches", async () => {
    const app = fakeApp();
    const result = await nexus(app, [
      "terminal",
      "wait",
      "codex",
      "--workspace",
      "api",
      "--match",
      "Work(ing|ed)",
      "--json",
    ]);
    expect(JSON.parse(result.stdout)).toMatchObject({ state: "matched" });
  });

  test("a pattern that backtracks without end ends the wait, not the app", async () => {
    const app = fakeApp();
    app.screens.set(CODEX_TAB, `${" ".repeat(40)}x`);
    const result = await nexus(app, [
      "terminal",
      "wait",
      "codex",
      "--workspace",
      "api",
      "--match",
      "( +)+$",
      "--json",
    ]);
    expect(JSON.parse(result.stdout)).toMatchObject({
      state: "error",
      message: "the pattern took too long to match: give a simpler one",
    });
  });
});

describe("terminal wait after worktree new --command", () => {
  const started = async (
    app: FakeApp,
    argv: string[] = ["--prompt", "add payments", "--command", "claude"],
  ) => {
    await nexus(app, ["worktree", "new", "pay", ...argv]);
    app.tabs[FIX] = [{ id: NEW_TAB, type: "terminal", title: "zsh", groupId: "g1", shown: false }];
    app.foreground.set(NEW_TAB, "-zsh");
    return app.time.now;
  };
  const wait = ["terminal", "wait", "cccccccc", "--workspace", "fix-login"];

  test("waits for the started agent's first turn, past its shell and Claude Code's idle start", async () => {
    const app = fakeApp();
    const start = await started(app);
    const key = `${FIX}:${NEW_TAB}`;
    app.time.onTick = (now) => {
      if (now - start === 2_000) app.foreground.set(NEW_TAB, "claude");
      if (now - start === 3_000) app.claude.set(key, { status: "idle", since: now });
      if (now - start === 4_000) app.claude.set(key, { status: "running", since: now });
      if (now - start === 9_000) {
        app.claude.set(key, { status: "completed", message: "Added payments.", since: now });
      }
    };
    const result = await nexus(app, wait);
    expect(result.stdout).toBe("Claude Code finished:\nAdded payments.\n");
    expect(app.time.now - start).toBe(9_000);
  });

  test("an agent told by its output is done once it goes quiet after printing", async () => {
    const app = fakeApp();
    const start = await started(app, ["--prompt", "add payments", "--command", "codex"]);
    app.time.onTick = (now) => {
      if (now - start === 1_000) app.foreground.set(NEW_TAB, "codex");
      if (now - start >= 2_000 && now - start <= 4_000) {
        app.activity.set(`${FIX}:${NEW_TAB}`, { lastOutputAt: now });
      }
    };
    const result = await nexus(app, wait);
    expect(result.stdout).toBe("zsh has been quiet for a while.\n");
    expect(app.time.now - start).toBe(9_000);
  });

  test("gives up on a command that started nothing after a minute", async () => {
    const app = fakeApp();
    const start = await started(app);
    const result = await nexus(app, wait);
    expect(result.stdout).toBe("zsh is back at its prompt.\n");
    expect(app.time.now - start).toBe(60_000);
  });

  test("returns at once without a prompt, which starts no turn", async () => {
    const app = fakeApp();
    const start = await started(app, ["--command", "claude"]);
    const result = await nexus(app, wait);
    expect(result.stdout).toBe("zsh is back at its prompt.\n");
    expect(app.time.now).toBe(start);
  });
});
