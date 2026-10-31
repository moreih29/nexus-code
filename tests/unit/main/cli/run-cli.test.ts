/**
 * runCli with the real command table over a made-up app: what an agent sees
 * when it asks about workspaces, terminals and sessions, and how a command
 * line it gets wrong is answered.
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
  FIX,
  fakeApp,
  SHELL_TAB,
} from "./fake-services";

async function nexus(argv: string[], app = fakeApp()) {
  return runCli(CLI_COMMANDS, contextFor(app, argv));
}

describe("help and mistakes", () => {
  test("bare nexus lists the commands", async () => {
    const result = await nexus([]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("terminal read [<tab>]");
    expect(result.stdout).toContain("session list");
  });

  test("a command's help shows its flags", async () => {
    const result = await nexus(["terminal", "read", "--help"]);
    expect(result.stdout).toContain("usage: nexus terminal read [<tab>] [flags]");
    expect(result.stdout).toContain("--lines N");
    expect(result.stdout).toContain("--json");
  });

  test.each([
    [
      "an unknown command",
      ["frobnicate"],
      'nexus: unknown command "frobnicate". Run "nexus help".\n',
    ],
    [
      "an unknown flag",
      ["terminal", "list", "--color"],
      "nexus: unknown flag --color\nusage: nexus terminal list [flags]\n",
    ],
    [
      "a flag missing its value",
      ["terminal", "read", "--lines"],
      "nexus: --lines needs a value\nusage: nexus terminal read [<tab>] [flags]\n",
    ],
    [
      "a word for a number",
      ["terminal", "read", "--lines", "many"],
      'nexus: --lines takes a number, not "many"\nusage: nexus terminal read [<tab>] [flags]\n',
    ],
  ])("%s is a usage error", async (_label, argv, stderr) => {
    const result = await nexus(argv);
    expect(result).toEqual({ stdout: "", stderr, exitCode: 2 });
  });

  test("a group name alone shows the group's commands", async () => {
    const result = await nexus(["terminal"]);
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toContain("terminal list");
    expect(result.stdout).not.toContain("workspace list");
  });
});

describe("workspaces", () => {
  test("list puts each worktree under its workspace and marks this one and the shown one", async () => {
    const result = await nexus(["workspace", "list"]);
    expect(result.stdout.split("\n")).toEqual([
      "ID        NAME         KIND                               LOCATION",
      "11111111  app          local               current,shown  /w/app",
      "33333333    fix-login  worktree:fix-login                 /home/u/.nexus-code/worktrees/app/fix-login",
      "22222222  api          local                              /w/api",
      "",
    ]);
  });

  test("--json gives full ids and the worktree's branch", async () => {
    const result = await nexus(["workspace", "list", "--json"]);
    const listed = JSON.parse(result.stdout) as Array<Record<string, unknown>>;
    expect(listed.map((w) => w.id)).toEqual([APP, FIX, API]);
    expect(listed[1]?.worktree).toEqual({
      parentId: APP,
      branch: "fix-login",
      path: "/home/u/.nexus-code/worktrees/app/fix-login",
    });
  });
});

describe("terminals and sessions", () => {
  test("terminal list says what runs in this workspace's terminals", async () => {
    const result = await nexus(["terminal", "list"]);
    expect(result.stdout.split("\n")).toEqual([
      "ID        TITLE                STATE",
      "aaaaaaaa  zsh (this terminal)  quiet",
      "aaaaaaaa  ✳ Claude Code        claude:completed",
      "",
    ]);
  });

  test("session list finds Claude by its hooks and Codex by its title and notification, everywhere", async () => {
    const result = await nexus(["session", "list", "--json"]);
    const sessions = JSON.parse(result.stdout) as Array<Record<string, unknown>>;
    expect(sessions.map((s) => [s.id, s.workspace, s.agent, s.state, s.message])).toEqual([
      [CLAUDE_TAB, "app", "claude", "completed", "Fixed the login bug."],
      [CODEX_TAB, "api", "codex", "busy", "Agent turn complete"],
    ]);
  });

  test("terminal read takes a terminal of another workspace by id prefix", async () => {
    const app = fakeApp();
    const result = await nexus(
      ["terminal", "read", "bbbb", "--workspace", "api", "--lines", "1"],
      app,
    );
    expect(result.stdout).toBe("• Working (12s)\n");
    expect(app.uiCalls.at(-1)).toEqual({
      op: "terminal.read",
      args: { workspaceId: API, tabId: CODEX_TAB, lines: 1 },
    });
  });

  test("a prefix two terminals share is refused with both named", async () => {
    const result = await nexus(["terminal", "read", "aaaa"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe(
      'nexus: "aaaa" matches more than one terminal in app: aaaaaaaa zsh, aaaaaaaa ✳ Claude Code\n',
    );
  });

  test("a terminal is not looked for among editors", async () => {
    const result = await nexus(["terminal", "read", "index.ts"]);
    expect(result.stderr).toBe('nexus: no terminal in app "index.ts"\n');
  });

  test("terminal read defaults to this terminal", async () => {
    const app = fakeApp();
    await nexus(["terminal", "read"], app);
    expect(app.uiCalls.at(-1)?.args).toMatchObject({ tabId: SHELL_TAB });
  });
});

describe("notify", () => {
  test("raises a notification for this terminal", async () => {
    const app = fakeApp();
    const result = await nexus(["notify", "Tests", "pass", "--title", "Build"], app);
    expect(result.stdout).toBe("Notified.\n");
    expect(app.notified).toEqual([
      { workspaceId: APP, tabId: SHELL_TAB, title: "Build", body: "Tests pass" },
    ]);
  });
});
