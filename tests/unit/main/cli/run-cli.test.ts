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
  BROWSER_TAB,
  CLAUDE_TAB,
  CODEX_TAB,
  contextFor,
  EDITOR_TAB,
  FIX,
  fakeApp,
  SHELL_TAB,
} from "./fake-services";

async function nexus(argv: string[], app = fakeApp(), invocation = {}) {
  return runCli(CLI_COMMANDS, contextFor(app, argv, undefined, invocation));
}

/** The arguments of the last request of `op` the command made of the renderer. */
function lastCall(app: ReturnType<typeof fakeApp>, op: string): unknown {
  return app.uiCalls.filter((c) => c.op === op).at(-1)?.args;
}

const BESIDE_ME = { background: false, besideTabId: SHELL_TAB };

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

describe("opening files", () => {
  test("open takes a line and column, and opens beside this terminal", async () => {
    const app = fakeApp();
    const result = await nexus(["open", "login.ts:12:5"], app, { cwd: "/w/app/src" });
    expect(result.stdout).toBe("Opened src/login.ts:12:5 (tab cccccccc).\n");
    expect(lastCall(app, "editor.open")).toEqual({
      workspaceId: APP,
      filePath: "/w/app/src/login.ts",
      line: 12,
      column: 5,
      placement: BESIDE_ME,
    });
  });

  test.each([
    ["a missing file", ["open", "nope.ts"], "nexus: no such file: nope.ts\n"],
    ["a folder", ["open", "src"], "nexus: src is a folder\n"],
    [
      "a file outside the workspace",
      ["open", "../api/main.go"],
      "nexus: ../api/main.go is not a file inside app (/w/app)\n",
    ],
  ])("open refuses %s", async (_label, argv, stderr) => {
    const app = fakeApp();
    const result = await nexus(argv, app);
    expect(result.stderr).toBe(stderr);
    expect(result.exitCode).toBe(1);
    expect(lastCall(app, "editor.open")).toBeUndefined();
  });

  test("diff compares the working tree with HEAD, or what --staged and --base say", async () => {
    const app = fakeApp();
    await nexus(["diff", "src/login.ts"], app);
    expect(lastCall(app, "diff.open")).toMatchObject({ leftRef: "HEAD", rightRef: "WORKING" });
    const result = await nexus(["diff", "src/login.ts", "--staged", "--base", "main"], app);
    expect(lastCall(app, "diff.open")).toEqual({
      workspaceId: APP,
      relPath: "src/login.ts",
      leftRef: "main",
      rightRef: "INDEX",
      placement: BESIDE_ME,
    });
    expect(result.stdout).toBe(
      "Opened the diff of src/login.ts, main against the index (tab cccccccc).\n",
    );
  });
});

describe("terminals", () => {
  test("terminal new opens behind this terminal, in its directory, running a command", async () => {
    const app = fakeApp();
    const result = await nexus(
      ["terminal", "new", "--command", "npm run dev", "--title", "dev"],
      app,
    );
    expect(lastCall(app, "terminal.open")).toEqual({
      workspaceId: APP,
      cwd: "/w/app",
      title: "dev",
      command: "npm run dev",
      placement: { background: true, besideTabId: SHELL_TAB },
    });
    expect(result.stdout).toBe("Opened terminal cccccccc in /w/app.\n");
  });

  test("terminal new --cwd is read from this directory; --show shows it", async () => {
    const app = fakeApp();
    await nexus(["terminal", "new", "--cwd", "web", "--show"], app, { cwd: "/w/app/src" });
    expect(lastCall(app, "terminal.open")).toMatchObject({
      cwd: "/w/app/src/web",
      placement: BESIDE_ME,
    });
  });

  test("terminal send pastes the words and presses Enter", async () => {
    const app = fakeApp();
    const result = await nexus(
      ["terminal", "send", "aaaaaaaa-0000-4000-8000-000000000002", "fix", "it"],
      app,
    );
    expect(lastCall(app, "terminal.input")).toEqual({
      workspaceId: APP,
      tabId: CLAUDE_TAB,
      text: "fix it",
      mode: "paste",
      enter: true,
    });
    expect(result.stdout).toBe("Sent to ✳ Claude Code (aaaaaaaa).\n");
  });

  test("terminal send - takes standard input, its last newline dropped", async () => {
    const app = fakeApp();
    await nexus(["terminal", "send", "✳ claude code", "-", "--no-enter"], app, {
      stdin: "first\nsecond\n",
    });
    expect(lastCall(app, "terminal.input")).toMatchObject({ text: "first\nsecond", enter: false });
  });

  test("terminal key sends the keys' bytes", async () => {
    const app = fakeApp();
    await nexus(["terminal", "key", "✳ claude code", "ctrl-c", "down", "enter", "y"], app);
    expect(lastCall(app, "terminal.input")).toMatchObject({
      text: "\x03\x1b[B\ry",
      mode: "keys",
      enter: false,
    });
  });

  test("terminal key refuses a key it does not know", async () => {
    const result = await nexus(["terminal", "key", "zsh", "hyper-x"]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toStartWith('nexus: unknown key "hyper-x".');
  });

  test("nothing is typed into this terminal", async () => {
    const app = fakeApp();
    const result = await nexus(["terminal", "send", ".", "hello"], app);
    expect(result.stderr).toBe(
      "nexus: that is this terminal; nexus types only into other terminals\n",
    );
    expect(lastCall(app, "terminal.input")).toBeUndefined();
  });

  test("nothing is typed while Claude Code waits for the user to allow a tool", async () => {
    const app = fakeApp();
    app.claude.set(`${APP}:${CLAUDE_TAB}`, { status: "permissionPending", since: Date.now() });
    const result = await nexus(["terminal", "key", "✳ claude code", "enter"], app);
    expect(result.stderr).toBe(
      "nexus: Claude Code there is waiting for the user to allow a tool; that is for the user to answer\n",
    );
    expect(lastCall(app, "terminal.input")).toBeUndefined();
  });
});

describe("tabs, browsers and workspaces", () => {
  test("tab close closes another tab, never this terminal", async () => {
    const app = fakeApp();
    expect((await nexus(["tab", "close", "index.ts"], app)).stdout).toBe(
      "Closed index.ts (aaaaaaaa).\n",
    );
    expect(lastCall(app, "tab.close")).toEqual({
      workspaceId: APP,
      tabId: EDITOR_TAB,
      force: false,
    });
    const self = await nexus(["tab", "close", "."], app);
    expect(self.stderr).toBe(
      "nexus: that is this terminal; close it in the app or exit its shell\n",
    );
  });

  test("tab show may show another workspace's tab", async () => {
    const app = fakeApp();
    const result = await nexus(["tab", "show", "codex", "--workspace", "api"], app);
    expect(result.exitCode).toBe(0);
    expect(lastCall(app, "tab.show")).toEqual({ workspaceId: API, tabId: CODEX_TAB });
  });

  test("browser open opens beside this terminal", async () => {
    const app = fakeApp();
    const result = await nexus(["browser", "open", "localhost:3000"], app);
    expect(lastCall(app, "browser.open")).toEqual({
      workspaceId: APP,
      url: "localhost:3000",
      placement: BESIDE_ME,
    });
    expect(result.stdout).toBe(
      'Loaded http://localhost:5173/ "Vite App" in a new tab, cccccccc.\n',
    );
  });

  test("browser goto and reload use the workspace's only browser tab, and wait for the load", async () => {
    const app = fakeApp();
    const went = await nexus(["browser", "goto", "localhost:5173/login"], app);
    expect(lastCall(app, "browser.navigate")).toEqual({
      workspaceId: APP,
      tabId: BROWSER_TAB,
      action: "goto",
      url: "localhost:5173/login",
    });
    expect(went.stdout).toBe('Loaded http://localhost:5173/ "Vite App" in aaaaaaaa.\n');
    expect((await nexus(["browser", "reload"], app)).stdout).toBe(
      "Reloaded in aaaaaaaa; at http://localhost:5173/.\n",
    );
    expect(app.browser.calls.map((c) => c.op)).toEqual(["settle", "settle"]);
  });

  test("workspace switch shows any workspace", async () => {
    const app = fakeApp();
    expect((await nexus(["workspace", "switch", "api"], app)).stdout).toBe(
      "Showing api (22222222).\n",
    );
    expect(lastCall(app, "workspace.show")).toEqual({ workspaceId: API });
  });

  test("worktree list and switch cover this workspace and its worktrees", async () => {
    const app = fakeApp();
    const list = await nexus(["worktree", "list"], app);
    expect(list.stdout.split("\n")[1]).toStartWith(
      "11111111  app        (workspace)  current,shown",
    );
    expect(list.stdout).toContain("33333333  fix-login  fix-login");
    await nexus(["worktree", "switch", "fix-login"], app);
    expect(lastCall(app, "workspace.show")).toEqual({ workspaceId: FIX });
  });
});
