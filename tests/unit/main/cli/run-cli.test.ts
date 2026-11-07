/**
 * runCli with the real command table over a made-up app: what an agent sees
 * when it asks about workspaces, terminals and sessions, and how a command
 * line it gets wrong is answered.
 */
import { describe, expect, test } from "bun:test";
import { CLI_COMMANDS } from "../../../../src/main/features/cli/commands";
import { runCli } from "../../../../src/main/features/cli/registry";
import { ForwardError } from "../../../../src/main/features/pty/forwards";
import type { ListeningPort } from "../../../../src/shared/pty/ports";
import type { WorkspaceMeta } from "../../../../src/shared/types/workspace";
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
  WORKSPACES,
} from "./fake-services";

async function nexus(argv: string[], app = fakeApp(), invocation = {}) {
  return runCli(CLI_COMMANDS, contextFor(app, argv, undefined, invocation));
}

/** The arguments of the last request of `op` the command made of the renderer. */
function lastCall(app: ReturnType<typeof fakeApp>, op: string): unknown {
  return app.uiCalls.filter((c) => c.op === op).at(-1)?.args;
}

const BESIDE_ME = { background: false, besideTabId: SHELL_TAB };

function listening(port: number, process = "node", tabId = SHELL_TAB): ListeningPort {
  return { port, pid: port * 10, process, tabId };
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

  test("a workspace with no tabs says so", async () => {
    expect((await nexus(["tab", "list", "--workspace", "fix-login"])).stdout).toBe(
      "No tabs in fix-login.\n",
    );
    expect((await nexus(["terminal", "list", "--workspace", "fix-login"])).stdout).toBe(
      "No terminals in fix-login.\n",
    );
    expect((await nexus(["tab", "list", "--workspace", "fix-login", "--json"])).stdout).toBe(
      "[]\n",
    );
  });

  test("session list finds Claude by its hooks and Codex by its title and notification, everywhere", async () => {
    const result = await nexus(["session", "list", "--json"]);
    const sessions = JSON.parse(result.stdout) as Array<Record<string, unknown>>;
    expect(sessions.map((s) => [s.id, s.workspace, s.agent, s.state, s.message])).toEqual([
      [CLAUDE_TAB, "app", "claude", "completed", "Fixed the login bug."],
      [CODEX_TAB, "api", "codex", "busy", "Agent turn complete"],
    ]);
  });

  test("--jsonl prints a list a record a line; one object on one line", async () => {
    const lines = (await nexus(["session", "list", "--jsonl"])).stdout.trimEnd().split("\n");
    expect(lines.map((line) => JSON.parse(line).id)).toEqual([CLAUDE_TAB, CODEX_TAB]);
    const status = (await nexus(["status", "--jsonl"])).stdout;
    expect(status.split("\n")).toHaveLength(2);
    expect(JSON.parse(status)).toHaveProperty("workspace.name", "app");
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

describe("show", () => {
  test("show opens HEAD's commit beside this terminal, or the one named", async () => {
    const app = fakeApp();
    const result = await nexus(["show"], app);
    expect(lastCall(app, "commit.open")).toEqual({
      workspaceId: APP,
      rev: "HEAD",
      placement: BESIDE_ME,
    });
    expect(result.stdout).toBe('Opened commit 4f2a9c1 "Fix the login redirect" (tab cccccccc).\n');
    await nexus(["show", "v1.2~1"], app);
    expect(lastCall(app, "commit.open")).toMatchObject({ rev: "v1.2~1" });
  });

  test("show refuses a name git would read as an option", async () => {
    const app = fakeApp();
    const result = await nexus(["show", "--", "--output=/tmp/x"], app);
    expect(result.stderr).toBe('nexus: no commit is named "--output=/tmp/x"\n');
    expect(result.exitCode).toBe(2);
    expect(lastCall(app, "commit.open")).toBeUndefined();
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

  test("terminal new --shell names the shell to run", async () => {
    const app = fakeApp();
    await nexus(["terminal", "new", "--shell", "fish"], app);
    expect(lastCall(app, "terminal.open")).toMatchObject({ workspaceId: APP, shell: "fish" });
  });

  test("terminal new --shell is refused in an SSH workspace", async () => {
    const app = fakeApp();
    const ssh = {
      ...WORKSPACES[1],
      location: { kind: "ssh", host: "devbox", remotePath: "/srv/api" },
    } as WorkspaceMeta;
    app.services = { ...app.services, listWorkspaces: () => [WORKSPACES[0], ssh] };
    const result = await nexus(["terminal", "new", "--shell", "bash", "--workspace", "api"], app);
    expect(result.stderr).toBe(
      "nexus: --shell is for local workspaces; api is an SSH workspace, whose terminals run devbox's login shell\n",
    );
    expect(lastCall(app, "terminal.open")).toBeUndefined();
  });

  test("terminal new --shell is refused in a WSL workspace", async () => {
    const app = fakeApp();
    const wsl = {
      ...WORKSPACES[1],
      location: { kind: "wsl", distro: "Ubuntu", remotePath: "/home/me/api" },
    } as WorkspaceMeta;
    app.services = { ...app.services, listWorkspaces: () => [WORKSPACES[0], wsl] };
    const result = await nexus(["terminal", "new", "--shell", "bash", "--workspace", "api"], app);
    expect(result.stderr).toBe(
      "nexus: --shell is for local workspaces; api is a WSL workspace, whose terminals run Ubuntu's login shell\n",
    );
    expect(lastCall(app, "terminal.open")).toBeUndefined();
  });

  test("terminal shells lists the shells, the default marked", async () => {
    const app = fakeApp();
    expect((await nexus(["terminal", "shells"], app)).stdout).toBe(
      "NAME           ID        PATH\n" +
        "zsh (default)  /bin/zsh  /bin/zsh\n" +
        "Fish           fish-1    fish\n",
    );
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

describe("unsaved tabs", () => {
  /** The app, with the editor's file and the Claude Code terminal marked unsaved. */
  function withUnsaved() {
    const app = fakeApp();
    app.tabs[APP] = (app.tabs[APP] ?? []).map((t) =>
      t.id === EDITOR_TAB || t.id === CLAUDE_TAB ? { ...t, unsaved: true } : t,
    );
    return app;
  }

  test("tab list marks unsaved tabs, and --unsaved lists only them", async () => {
    const app = withUnsaved();
    expect((await nexus(["tab", "list"], app)).stdout).toContain("index.ts (unsaved)");
    const only = await nexus(["tab", "list", "--unsaved"], app);
    expect(only.stdout.split("\n").filter(Boolean)).toHaveLength(3);
    expect(only.stdout).not.toContain("Vite App");
    expect((await nexus(["tab", "list", "--unsaved"])).stdout).toBe(
      "No unsaved changes in app's tabs.\n",
    );
  });

  test("tab save saves the tab named, and says when it had nothing to save", async () => {
    const app = withUnsaved();
    expect((await nexus(["tab", "save", "index.ts"], app)).stdout).toBe(
      "Saved index.ts (tab aaaaaaaa).\n",
    );
    expect(lastCall(app, "tab.save")).toEqual({ workspaceId: APP, tabId: EDITOR_TAB });
    expect((await nexus(["tab", "revert", "index.ts"])).stdout).toBe(
      "index.ts had no unsaved changes (tab aaaaaaaa).\n",
    );
  });

  test("tab save --all saves each unsaved tab, and tells which it left", async () => {
    const result = await nexus(["tab", "save", "--all"], withUnsaved());
    expect(result.stdout).toBe(
      "Left ✳ Claude Code (tab aaaaaaaa): only an editor or a diff has a file to save.\n" +
        "Saved index.ts (tab aaaaaaaa).\n",
    );
    expect(result.exitCode).toBe(1);
  });

  test("tab save names one tab, or --all and none", async () => {
    expect((await nexus(["tab", "save"])).stderr).toContain("missing <tab>");
    expect((await nexus(["tab", "save", "--all", "index.ts"])).stderr).toContain(
      'unexpected argument "index.ts"',
    );
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

  test("browser open takes a bare path to the one port the workspace's terminals listen on", async () => {
    const app = fakeApp();
    app.ports[APP] = [listening(5173)];
    const result = await nexus(["browser", "open", "/login?next=%2F"], app);
    expect(result.exitCode).toBe(0);
    expect(lastCall(app, "browser.open")).toEqual({
      workspaceId: APP,
      url: "http://localhost:5173/login?next=%2F",
      placement: BESIDE_ME,
    });
  });

  test("browser goto takes a bare path the same way, spaces around it or not", async () => {
    const app = fakeApp();
    app.ports[APP] = [listening(5173)];
    await nexus(["browser", "goto", " /login "], app);
    expect(lastCall(app, "browser.navigate")).toEqual({
      workspaceId: APP,
      tabId: BROWSER_TAB,
      action: "goto",
      url: "http://localhost:5173/login",
    });
    // A URL without its scheme is no path.
    await nexus(["browser", "goto", "//example.com/a"], app);
    expect(lastCall(app, "browser.navigate")).toMatchObject({ url: "//example.com/a" });
  });

  test("browser open with a bare path says so when the workspace is not connected", async () => {
    const app = fakeApp();
    app.ports[APP] = new Error("app is not connected");
    expect((await nexus(["browser", "open", "/"], app)).stderr).toBe(
      "nexus: could not look at app's ports: app is not connected\n",
    );
  });

  test("browser open with a bare path says which ports there are when it is not one", async () => {
    const app = fakeApp();
    const none = await nexus(["browser", "open", "/"], app);
    expect(none.stderr).toBe(
      "nexus: no program in app's terminals listens on a port; start its dev server, or give a URL such as localhost:3000/\n",
    );
    app.ports[APP] = [listening(5173), listening(8787, "workerd")];
    const several = await nexus(["browser", "open", "/"], app);
    expect(several.stderr).toBe(
      "nexus: app's terminals listen on several ports, :5173 (node), :8787 (workerd); give one, as localhost:5173/\n",
    );
    app.ports[APP] = new Error("unsupported method");
    expect((await nexus(["browser", "open", "/"], app)).stderr).toBe(
      "nexus: could not look at app's ports: unsupported method\n",
    );
    expect(lastCall(app, "browser.open")).toBeUndefined();
  });

  /** The app, with "api" on the SSH host devbox. */
  function sshApp() {
    const app = fakeApp();
    const ssh = {
      ...WORKSPACES[1],
      location: { kind: "ssh", host: "devbox", remotePath: "/srv/api" },
    } as WorkspaceMeta;
    app.services = { ...app.services, listWorkspaces: () => [WORKSPACES[0], ssh] };
    app.settings.crossWorkspace = "allow";
    return app;
  }

  test("browser open in an SSH workspace opens a local address on its forward", async () => {
    const app = sshApp();
    app.ports[API] = [listening(3000)];
    app.forwarding.to[3000] = 3001;
    await nexus(["browser", "open", "/login", "--workspace", "api"], app);
    expect(lastCall(app, "browser.open")).toMatchObject({
      workspaceId: API,
      url: "http://localhost:3001/login",
    });
    // A URL elsewhere is as given.
    await nexus(["browser", "open", "example.com", "--workspace", "api"], app);
    expect(lastCall(app, "browser.open")).toMatchObject({ url: "example.com" });
    app.forwarding.error = new ForwardError("not-connected", "devbox is not connected");
    const refused = await nexus(["browser", "open", "localhost:8080", "--workspace", "api"], app);
    expect(refused.stderr).toBe("nexus: devbox is not connected\n");
  });

  test("port list in an SSH workspace shows where forwarded ports open here", async () => {
    const app = sshApp();
    app.ports[API] = [listening(3000, "node", CODEX_TAB), listening(8080, "java", CODEX_TAB)];
    app.forwarding.forwards[API] = [{ remotePort: 3000, localPort: 3001, active: true }];
    const result = await nexus(["port", "list", "--workspace", "api"], app);
    expect(result.stdout).toContain("http://localhost:3001\n");
    expect(result.stdout).toContain(
      "These are on devbox; nexus port forward 8080 opens one here.\n",
    );
    const json = await nexus(["port", "list", "--workspace", "api", "--json"], app);
    expect(JSON.parse(json.stdout).map((p: { url: unknown }) => p.url)).toEqual([
      "http://localhost:3001",
      null,
    ]);

    // A server started outside the terminals, forwarded all the same.
    app.forwarding.forwards[API].push({ remotePort: 9000, localPort: 9000, active: false });
    expect((await nexus(["port", "list", "--workspace", "api"], app)).stdout).toContain(
      "Also forwarded: 9000 at http://localhost:9000 (once reconnected).\n",
    );
    app.ports[API] = [];
    expect((await nexus(["port", "list", "--workspace", "api"], app)).stdout).toBe(
      "No program in api's terminals listens on a port.\nAlso forwarded: 3000 at http://localhost:3001, 9000 at http://localhost:9000 (once reconnected).\n",
    );
  });

  test("port forward and unforward start and stop a forward of an SSH workspace", async () => {
    const app = sshApp();
    app.forwarding.to[5173] = 5174;
    expect((await nexus(["port", "forward", "5173", "--workspace", "api"], app)).stdout).toBe(
      "devbox:5173 is at http://localhost:5174.\n",
    );
    expect(app.forwarding.forwards[API]).toEqual([
      { remotePort: 5173, localPort: 5174, active: true },
    ]);
    expect((await nexus(["port", "unforward", ":5173", "--workspace", "api"], app)).stdout).toBe(
      "Stopped forwarding devbox:5173.\n",
    );
    expect(app.forwarding.forwards[API]).toEqual([]);
    expect((await nexus(["port", "unforward", "5173", "--workspace", "api"], app)).stderr).toBe(
      "nexus: devbox:5173 is not forwarded\n",
    );
    expect((await nexus(["port", "forward", "http", "--workspace", "api"], app)).stderr).toContain(
      '"http" is not a port number',
    );
    expect((await nexus(["port", "forward", "5173"], app)).stderr).toBe(
      "nexus: app is on this machine; its ports need no forwarding\n",
    );
  });

  test("port list shows each port's program and terminal", async () => {
    const app = fakeApp();
    expect((await nexus(["port", "list"], app)).stdout).toBe(
      "No program in app's terminals listens on a port.\n",
    );
    app.ports[APP] = [listening(5173, "node", SHELL_TAB)];
    const result = await nexus(["port", "list"], app);
    expect(result.stdout).toBe(
      "PORT  PID    PROCESS  TERMINAL  TITLE  URL\n" +
        "5173  51730  node     aaaaaaaa  zsh    http://localhost:5173\n",
    );
    const json = await nexus(["port", "list", "--json"], app);
    expect(JSON.parse(json.stdout)).toEqual([
      { port: 5173, pid: 51730, process: "node", tabId: SHELL_TAB, url: "http://localhost:5173" },
    ]);
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

  test("browser open and goto say when the URL is a file the browser downloads, or nothing loaded", async () => {
    const app = fakeApp();
    app.browser.settled = {
      url: "",
      title: "",
      download: {
        url: "http://localhost:8123/README.md",
        file: "/tmp/nexus-downloads/README.md",
        type: "application/octet-stream",
      },
    };
    expect((await nexus(["browser", "open", "localhost:8123/README.md"], app)).stdout).toBe(
      "Downloading http://localhost:8123/README.md (application/octet-stream) to /tmp/nexus-downloads/README.md rather than showing it in a new tab, cccccccc.\n",
    );
    // A tab with a page keeps it.
    app.browser.settled = { ...app.browser.settled, url: "http://localhost:5173/" };
    expect((await nexus(["browser", "goto", "localhost:8123/README.md"], app)).stdout).toBe(
      "Downloading http://localhost:8123/README.md (application/octet-stream) to /tmp/nexus-downloads/README.md rather than showing it in aaaaaaaa.\n",
    );
    app.browser.settled = { url: "", title: "" };
    expect((await nexus(["browser", "open", "localhost:8123/x"], app)).stdout).toBe(
      "Nothing loaded from http://localhost:8123/x/ in a new tab, cccccccc.\n",
    );
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
