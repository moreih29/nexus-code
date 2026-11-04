/**
 * nexus workspace add and remove: folders put in the app's list from a
 * terminal, and workspaces taken out of it with the user's leave.
 */
import { describe, expect, test } from "bun:test";
import { CLI_COMMANDS } from "../../../../src/main/features/cli/commands";
import { runCli } from "../../../../src/main/features/cli/registry";
import type { WorkspaceMeta } from "../../../../src/shared/types/workspace";
import {
  ADDED,
  API,
  APP,
  contextFor,
  type FakeApp,
  FIX,
  fakeApp,
  SHELL_TAB,
} from "./fake-services";

/** A terminal of the "fix-login" worktree. */
const IN_FIX = { workspaceId: FIX, tabId: "dddddddd-0000-4000-8000-000000000007" };
/** A terminal of "api". */
const IN_API = { workspaceId: API, tabId: "bbbbbbbb-0000-4000-8000-000000000003" };

async function nexus(
  app: FakeApp,
  argv: string[],
  caller = { workspaceId: APP, tabId: SHELL_TAB },
) {
  return runCli(CLI_COMMANDS, contextFor(app, argv, caller));
}

function uiArgs(app: FakeApp, op: string): unknown {
  return app.uiCalls.find((c) => c.op === op)?.args;
}

describe("workspace add", () => {
  test("adds a folder from this terminal's directory, without showing it", async () => {
    const app = fakeApp();
    const result = await nexus(app, ["workspace", "add", "../lib"]);
    expect(result.stdout).toBe("Added: lib (44444444) /w/lib\n");
    expect(app.added).toEqual([
      { location: { kind: "local", rootPath: "/w/lib" }, name: undefined },
    ]);
    expect(uiArgs(app, "workspace.show")).toBeUndefined();
    expect(app.asked).toEqual([]);
  });

  test("--name names it and --show shows it", async () => {
    const app = fakeApp();
    const json = JSON.parse(
      (await nexus(app, ["workspace", "add", "/srv/web", "--name", "Web", "--show", "--json"]))
        .stdout,
    );
    expect(json).toMatchObject({ id: ADDED, name: "Web", added: true });
    expect(app.added[0]?.name).toBe("Web");
    expect(uiArgs(app, "workspace.show")).toEqual({ workspaceId: ADDED });
  });

  test("a folder already listed gives that workspace", async () => {
    const app = fakeApp();
    const result = await nexus(app, ["workspace", "add", "/w/api/"]);
    expect(result.stdout).toBe("Already listed: api (22222222) /w/api\n");
    expect(app.workspaces).toHaveLength(3);
  });

  test("an SSH terminal adds a folder on its own host, reached as its workspace is", async () => {
    const app = fakeApp();
    const ssh = {
      ...(app.workspaces[1] as WorkspaceMeta),
      location: {
        kind: "ssh",
        host: "devbox",
        user: "me",
        port: 2222,
        identityFile: "~/.ssh/devbox",
        remotePath: "/srv/api",
      },
      rootPath: "/srv/api",
    } as WorkspaceMeta;
    app.workspaces[1] = ssh;
    const result = await runCli(
      CLI_COMMANDS,
      contextFor(app, ["workspace", "add", "../web"], IN_API, { cwd: "/srv/api" }),
    );
    expect(result.stdout).toBe("Added: web (44444444) me@devbox:/srv/web\n");
    expect(app.added[0]?.location).toEqual({
      kind: "ssh",
      host: "devbox",
      user: "me",
      port: 2222,
      identityFile: "~/.ssh/devbox",
      remotePath: "/srv/web",
    });
  });

  test("wants one folder", async () => {
    const app = fakeApp();
    expect((await nexus(app, ["workspace", "add"])).exitCode).not.toBe(0);
    expect(app.added).toEqual([]);
  });
});

describe("workspace remove", () => {
  test("asks, then removes another workspace and its worktrees' tasks", async () => {
    const app = fakeApp();
    app.answers.push("once");
    const result = await nexus(app, ["workspace", "remove", "app"], IN_API);
    expect(result.stdout).toBe(
      "Removed workspace app (11111111) with its 1 worktree task; folders are kept.\n",
    );
    expect(app.asked[0]).toMatchObject({
      fromWorkspaceId: API,
      toWorkspaceId: APP,
      change: { kind: "workspaceRemove" },
    });
    expect(uiArgs(app, "workspace.remove")).toEqual({ workspaceId: APP });
  });

  test("does nothing when the user refuses", async () => {
    const app = fakeApp();
    const result = await nexus(app, ["workspace", "remove", "api"]);
    expect(result.stderr).toBe("nexus: the user did not allow it\n");
    expect(uiArgs(app, "workspace.remove")).toBeUndefined();
  });

  test("--json gives what went", async () => {
    const app = fakeApp();
    app.settings.crossWorkspace = "allow";
    const json = JSON.parse((await nexus(app, ["workspace", "remove", "api", "--json"])).stdout);
    expect(json).toEqual({
      id: API,
      name: "api",
      location: { kind: "local", rootPath: "/w/api" },
      tasks: [],
    });
  });

  test("refuses this terminal's own workspace, from it or from one of its worktrees", async () => {
    const app = fakeApp();
    app.settings.crossWorkspace = "allow";
    for (const caller of [{ workspaceId: APP, tabId: SHELL_TAB }, IN_FIX]) {
      const result = await nexus(app, ["workspace", "remove", "app"], caller);
      expect(result.stderr).toBe(
        "nexus: this terminal is in that workspace; remove it from another terminal\n",
      );
    }
    expect(uiArgs(app, "workspace.remove")).toBeUndefined();
  });

  test("leaves a worktree to worktree remove", async () => {
    const app = fakeApp();
    app.settings.crossWorkspace = "allow";
    const result = await nexus(app, ["workspace", "remove", "fix-login"], IN_API);
    expect(result.stderr).toBe(
      "nexus: fix-login is a worktree; remove it with nexus worktree remove\n",
    );
    expect(app.asked).toEqual([]);
  });
});
