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
  CLAUDE_TAB,
  CODEX_TAB,
  contextFor,
  EDITOR_TAB,
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

function listening(port: number, process = "node", tabId = SHELL_TAB): ListeningPort {
  return { port, pid: port * 10, process, tabId };
}

describe("terminals and sessions", () => {
  test("JSON is ASCII alone, for a reader that takes it in another code page", async () => {
    for (const flag of ["--json", "--jsonl"]) {
      const { stdout } = await nexus(["terminal", "list", flag]);
      expect(stdout).toMatch(/^[ -~\n]*$/);
      expect(stdout).toContain("\\u2733 Claude Code");
      expect(stdout.includes("✳")).toBe(false);
    }
    const listed = JSON.parse((await nexus(["terminal", "list", "--json"])).stdout);
    expect(listed.map((t: { title: string }) => t.title)).toContain("✳ Claude Code");
  });

  test("a prefix two terminals share is refused with both named", async () => {
    const result = await nexus(["terminal", "read", "aaaa"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe(
      'nexus: "aaaa" matches more than one terminal in app: aaaaaaaa zsh, aaaaaaaa ✳ Claude Code\n',
    );
  });
});

describe("opening files", () => {
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
});

describe("show", () => {
  test("show refuses a name git would read as an option", async () => {
    const app = fakeApp();
    const result = await nexus(["show", "--", "--output=/tmp/x"], app);
    expect(result.stderr).toBe('nexus: no commit is named "--output=/tmp/x"\n');
    expect(result.exitCode).toBe(2);
    expect(lastCall(app, "commit.open")).toBeUndefined();
  });
});

describe("terminals", () => {
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

  test("tab close --saved closes the editors with nothing unsaved", async () => {
    const app = fakeApp();
    app.tabs[APP] = (app.tabs[APP] ?? []).map((t) =>
      t.id === EDITOR_TAB ? { ...t, unsaved: true } : t,
    );
    expect((await nexus(["tab", "close", "--saved"], app)).stdout).toBe("No tabs to close.\n");
    const clean = fakeApp();
    expect((await nexus(["tab", "close", "--saved"], clean)).stdout).toBe("Closed 1 tab in app.\n");
    expect(lastCall(clean, "tab.close")).toMatchObject({ tabId: EDITOR_TAB });
  });

  test("tab close --all leaves this terminal, and tells which others it left", async () => {
    const app = fakeApp();
    app.closeRefused.set(CLAUDE_TAB, "claude is running there; add --force to close it anyway");
    const result = await nexus(["tab", "close", "--all"], app);
    expect(result.stdout).toBe(
      "Closed 2 tabs in app.\n" +
        "Left zsh (aaaaaaaa) open: it is this terminal.\n" +
        "Left ✳ Claude Code (aaaaaaaa) open: claude is running there; add --force to close it anyway.\n",
    );
    expect(result.exitCode).toBe(1);
    expect(app.tabs[APP]?.map((t) => t.id)).toEqual([SHELL_TAB, CLAUDE_TAB]);
    expect((await nexus(["tab", "close", "--all", "--saved"], app)).exitCode).toBe(2);
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
});
