/**
 * nexus worktree new and remove: the app's tasks made and deleted from a
 * terminal, with the user's leave where they reach past its workspace.
 */
import { describe, expect, test } from "bun:test";
import { CLI_COMMANDS } from "../../../../src/main/features/cli/commands";
import { runCli } from "../../../../src/main/features/cli/registry";
import {
  APP,
  contextFor,
  type FakeApp,
  FIX,
  fakeApp,
  NEW_TAB,
  SHELL_TAB,
  WORKSPACES,
} from "./fake-services";

/** A terminal of the "fix-login" worktree. */
const IN_FIX = { workspaceId: FIX, tabId: "dddddddd-0000-4000-8000-000000000007" };

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

describe("worktree new", () => {
  test("from a worktree, branches off the workspace it belongs to", async () => {
    const app = fakeApp();
    app.answers.push("once");
    await nexus(app, ["worktree", "new", "pay"], IN_FIX);
    expect(uiArgs(app, "task.create")).toMatchObject({ parentId: APP });
    // The workspace is not the worktree's own, so the user is asked.
    expect(app.asked[0]?.change).toEqual({ kind: "worktreeNew", detail: "pay" });
  });
});

describe("worktree claude-create", () => {
  /** Runs the hidden command as Claude Code's WorktreeCreate hook does, with its JSON on stdin. */
  function hook(app: FakeApp, stdin: string, caller = { workspaceId: APP, tabId: SHELL_TAB }) {
    return runCli(
      CLI_COMMANDS,
      contextFor(app, ["worktree", "claude-create", "-"], caller, { stdin }),
    );
  }

  test("makes a task with a plain shell behind the user's view and prints only its folder", async () => {
    const app = fakeApp();
    const result = await hook(
      app,
      JSON.stringify({ hook_event_name: "WorktreeCreate", name: "feature-auth" }),
    );
    expect(result).toEqual({
      stdout: "/home/u/.nexus-code/worktrees/app/fix-login\n",
      stderr: "",
      exitCode: 0,
    });
    expect(uiArgs(app, "task.create")).toEqual({
      parentId: APP,
      name: "feature-auth",
      prompt: "",
      start: { command: "" },
      show: false,
      createdBy: { workspaceId: APP, tabId: SHELL_TAB },
    });
    expect(app.asked).toEqual([]);
  });

  test("from a Claude Code inside a task, makes the worktree beside it once the user allows", async () => {
    const app = fakeApp();
    app.answers.push("once");
    expect((await hook(app, JSON.stringify({ name: "agent-b1" }), IN_FIX)).exitCode).toBe(0);
    expect(app.asked[0]?.change).toEqual({ kind: "worktreeNew", detail: "agent-b1" });
    expect(uiArgs(app, "task.create")).toMatchObject({ parentId: APP, name: "agent-b1" });
  });

  test("fails, so Claude Code makes no worktree, on JSON without a name", async () => {
    const app = fakeApp();
    expect((await hook(app, "{}")).exitCode).not.toBe(0);
    expect((await hook(app, "not json")).exitCode).not.toBe(0);
    expect(uiArgs(app, "task.create")).toBeUndefined();
  });
});

describe("worktree claude-remove", () => {
  const FIX_FOLDER = "/home/u/.nexus-code/worktrees/app/fix-login";

  /**
   * Runs the hidden command as Claude Code's WorktreeRemove hook does, with
   * "fix-login" made by `madeBy` (by the user in the app when absent).
   */
  function hook(app: FakeApp, stdin: string, madeBy?: { workspaceId: string; tabId: string }) {
    const ctx = contextFor(app, ["worktree", "claude-remove", "-"], undefined, { stdin });
    const workspaces = WORKSPACES.map((w) =>
      w.id === FIX && w.task && madeBy ? { ...w, task: { ...w.task, createdBy: madeBy } } : w,
    );
    return runCli(CLI_COMMANDS, {
      ...ctx,
      services: { ...ctx.services, listWorkspaces: () => workspaces },
    });
  }
  const payload = (path: string) =>
    JSON.stringify({ hook_event_name: "WorktreeRemove", worktree_path: path });

  test("removes the worktree this terminal's Claude Code made without asking, its branch only if merged", async () => {
    const app = fakeApp();
    const result = await hook(app, payload(`${FIX_FOLDER}/`), {
      workspaceId: APP,
      tabId: SHELL_TAB,
    });
    expect(result).toEqual({
      stdout: "Removed worktree fix-login (33333333).\n",
      stderr: "",
      exitCode: 0,
    });
    expect(uiArgs(app, "task.remove")).toEqual({
      taskId: FIX,
      force: false,
      deleteBranch: "merged",
    });
    expect(app.asked).toEqual([]);
  });

  test("asks first for a worktree another terminal or the user made", async () => {
    for (const madeBy of [undefined, { workspaceId: APP, tabId: NEW_TAB }]) {
      const app = fakeApp();
      app.answers.push("once");
      expect((await hook(app, payload(FIX_FOLDER), madeBy)).exitCode).toBe(0);
      expect(app.asked[0]?.change).toEqual({ kind: "worktreeRemove" });
      expect(uiArgs(app, "task.remove")).toMatchObject({ taskId: FIX });

      const declined = fakeApp();
      expect((await hook(declined, payload(FIX_FOLDER), madeBy)).exitCode).toBe(1);
      expect(uiArgs(declined, "task.remove")).toBeUndefined();
    }
  });

  test("fails, so Claude Code keeps it, on a folder no worktree has or JSON without one", async () => {
    const app = fakeApp();
    expect(await hook(app, payload("/w/app/.claude/worktrees/x"))).toEqual({
      stdout: "",
      stderr: "nexus: no worktree of this workspace is at /w/app/.claude/worktrees/x\n",
      exitCode: 1,
    });
    // The workspace itself is not a worktree to remove.
    expect((await hook(app, payload("/w/app"))).exitCode).toBe(1);
    expect((await hook(app, "{}")).exitCode).not.toBe(0);
    expect(uiArgs(app, "task.remove")).toBeUndefined();
  });
});

describe("worktree remove", () => {
  test("asks, then removes it and keeps its branch", async () => {
    const app = fakeApp();
    app.answers.push("once");
    const result = await nexus(app, ["worktree", "remove", "fix-login"]);
    expect(result.stdout).toBe(
      "Removed worktree fix-login (33333333); branch fix-login is kept.\n",
    );
    expect(app.asked).toEqual([
      {
        fromWorkspaceId: APP,
        fromTabId: SHELL_TAB,
        toWorkspaceId: FIX,
        change: { kind: "worktreeRemove" },
      },
    ]);
    expect(uiArgs(app, "task.remove")).toEqual({ taskId: FIX, force: false, deleteBranch: false });
  });

  test("--force and --delete-branch go through, and the user is told of the branch", async () => {
    const app = fakeApp();
    app.answers.push("once");
    const result = await nexus(app, [
      "worktree",
      "remove",
      "33333333",
      "--force",
      "--delete-branch",
    ]);
    expect(result.stdout).toBe("Removed worktree fix-login (33333333) and branch fix-login.\n");
    expect(app.asked[0]?.change).toEqual({ kind: "worktreeRemoveBranch" });
    expect(uiArgs(app, "task.remove")).toEqual({ taskId: FIX, force: true, deleteBranch: true });
  });

  test("removes nothing the user turns down", async () => {
    const app = fakeApp();
    const result = await nexus(app, ["worktree", "remove", "fix-login"]);
    expect(result.exitCode).toBe(1);
    expect(uiArgs(app, "task.remove")).toBeUndefined();
  });

  test("refuses the workspace itself and the worktree it runs in", async () => {
    const app = fakeApp();
    expect((await nexus(app, ["worktree", "remove", "app"])).stderr).toBe(
      "nexus: app is a workspace, not a worktree\n",
    );
    expect((await nexus(app, ["worktree", "remove", "fix-login"], IN_FIX)).stderr).toBe(
      "nexus: this terminal is in that worktree; remove it from another terminal\n",
    );
    expect(app.asked).toEqual([]);
  });
});
