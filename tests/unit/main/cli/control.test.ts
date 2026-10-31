/**
 * nexus reaching past its own workspace and waiting on other terminals:
 * the user's leave for changes elsewhere, terminal wait and send --wait, and
 * the note Claude Code sessions get at their start.
 */
import { describe, expect, test } from "bun:test";
import { CLI_COMMANDS } from "../../../../src/main/features/cli/commands";
import { runCli } from "../../../../src/main/features/cli/registry";
import {
  API,
  APP,
  CLAUDE_TAB,
  CODEX_TAB,
  contextFor,
  type FakeApp,
  fakeApp,
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
        change: { kind: "terminalInput", detail: "codex" },
      },
    ]);
    expect(app.uiCalls.at(-1)).toMatchObject({ op: "terminal.input", args: { tabId: CODEX_TAB } });
  });

  test("asks again after once, not after until-restart", async () => {
    const app = fakeApp();
    app.answers.push("once", "session");
    await nexus(app, argv);
    await nexus(app, argv);
    await nexus(app, argv);
    expect(app.asked).toHaveLength(2);
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
      "nexus: changing other workspaces is turned off in NexusCode's settings (Agent CLI)\n",
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
});

describe("terminal wait", () => {
  test("returns at once for a Claude Code that is not running", async () => {
    const app = fakeApp();
    const result = await nexus(app, ["terminal", "wait", "✳ claude code"]);
    expect(result.stdout).toBe("Claude Code finished:\nFixed the login bug.\n");
  });

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

  test("send --wait takes a Claude Code that never starts as idle after a grace", async () => {
    const app = fakeApp();
    const sentAt = app.time.now;
    const result = await nexus(app, ["terminal", "send", "✳ claude code", "/help", "--wait"]);
    expect(result.exitCode).toBe(0);
    expect(app.time.now - sentAt).toBe(10_000);
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

  test("--match waits for a line on the screen", async () => {
    const app = fakeApp();
    app.tabs[APP]?.push({
      id: SERVER_TAB,
      type: "terminal",
      title: "dev",
      groupId: "g1",
      shown: false,
    });
    const start = app.time.now;
    app.time.onTick = (now) => {
      if (now - start === 1_000)
        app.screens.set(SERVER_TAB, "vite\n  ➜  Local:   http://localhost:5173/");
    };
    const result = await nexus(app, ["terminal", "wait", "dev", "--match", "Local:\\s+http"]);
    expect(result.stdout).toBe("  ➜  Local:   http://localhost:5173/\n");
  });

  test("--exit waits for the terminal to exit", async () => {
    const app = fakeApp();
    const start = app.time.now;
    app.time.onTick = (now) => {
      const codex = app.tabs[API]?.[0];
      if (codex && now - start === 2_000) app.tabs[API] = [{ ...codex, dead: true }];
    };
    const result = await nexus(app, ["terminal", "wait", "codex", "--workspace", "api", "--exit"]);
    expect(result.stdout).toBe("codex has exited.\n");
  });

  test("exits 124 when the wait runs out", async () => {
    const app = fakeApp();
    app.claude.set(`${APP}:${CLAUDE_TAB}`, { status: "running", since: app.time.now });
    const result = await nexus(app, ["terminal", "wait", "✳ claude code", "--timeout", "3s"]);
    expect(result.exitCode).toBe(124);
    expect(result.stdout).toStartWith("✳ Claude Code was still busy when the wait ran out");
  });

  test.each([
    [["terminal", "wait", "codex", "--timeout", "2h"], "nexus: --timeout is at most 30m\n"],
    [["terminal", "wait", "codex", "--match", "("], "nexus: --match: "],
  ])("%j is a usage error", async (argv, stderr) => {
    const result = await nexus(fakeApp(), [...argv, "--workspace", "api"]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toStartWith(stderr);
  });
});

describe("agent-context", () => {
  test("tells a session where it runs and what nexus does, and is not in help", async () => {
    const app = fakeApp();
    const result = await nexus(app, ["agent-context"]);
    expect(result.stdout).toStartWith(
      'You are running in a terminal of NexusCode (workspace "app", terminal aaaaaaaa).',
    );
    expect(result.stdout).toContain("nexus help");
    expect((await nexus(app, ["help"])).stdout).not.toContain("agent-context");
  });

  test("prints nothing when the setting is off", async () => {
    const app = fakeApp();
    app.settings.agentContext = false;
    expect(await nexus(app, ["agent-context"])).toEqual({ stdout: "", stderr: "", exitCode: 0 });
  });
});
