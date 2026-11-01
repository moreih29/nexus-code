/**
 * nexus worktree new and remove: the app's tasks made and deleted from a
 * terminal, with the user's leave where they reach past its workspace.
 */
import { describe, expect, test } from "bun:test";
import { CLI_COMMANDS } from "../../../../src/main/features/cli/commands";
import { runCli } from "../../../../src/main/features/cli/registry";
import {
  API,
  APP,
  contextFor,
  type FakeApp,
  FIX,
  fakeApp,
  NEW_TAB,
  SHELL_TAB,
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
  test("makes one of this workspace behind the user's view, and prints its terminal", async () => {
    const app = fakeApp();
    const result = await nexus(app, ["worktree", "new", "fix login", "--prompt", "fix it"]);
    expect(result.stdout).toBe(
      "Made worktree fix-login (33333333) on branch fix-login, at /home/u/.nexus-code/worktrees/app/fix-login.\n" +
        "Its terminal cccccccc runs claude with the prompt. To wait for it:\n" +
        "  nexus terminal wait cccccccc --workspace 33333333\n",
    );
    expect(uiArgs(app, "task.create")).toEqual({
      parentId: APP,
      name: "fix login",
      prompt: "fix it",
      show: false,
      createdBy: { workspaceId: APP, tabId: SHELL_TAB },
    });
    expect(app.asked).toEqual([]);
  });

  test("--json gives the worktree, its terminal and the command", async () => {
    const app = fakeApp();
    const made = JSON.parse(
      (await nexus(app, ["worktree", "new", "fix login", "--show", "--json"])).stdout,
    );
    expect(made).toMatchObject({
      id: FIX,
      worktree: { parentId: APP, branch: "fix-login" },
      tabId: NEW_TAB,
      command: "claude",
    });
    expect(uiArgs(app, "task.create")).toMatchObject({ prompt: "", show: true });
  });

  test("--command runs another agent, and an empty one a plain shell", async () => {
    const app = fakeApp();
    const result = await nexus(app, [
      "worktree",
      "new",
      "pay",
      "--command",
      "codex -m gpt-5.5",
      "--prompt",
      "add refunds",
    ]);
    expect(uiArgs(app, "task.create")).toMatchObject({ command: "codex -m gpt-5.5" });
    expect(result.stdout).toContain("Its terminal cccccccc runs codex -m gpt-5.5 with the prompt.");

    const shell = fakeApp();
    expect((await nexus(shell, ["worktree", "new", "pay", "--command", ""])).stdout).toContain(
      "Its terminal is cccccccc; terminal commands reach it with --workspace 33333333.\n",
    );
    expect(uiArgs(shell, "task.create")).toMatchObject({ command: "" });
  });

  test("from a worktree, branches off the workspace it belongs to", async () => {
    const app = fakeApp();
    app.answers.push("once");
    await nexus(app, ["worktree", "new", "pay"], IN_FIX);
    expect(uiArgs(app, "task.create")).toMatchObject({ parentId: APP });
    // The workspace is not the worktree's own, so the user is asked.
    expect(app.asked[0]?.change).toEqual({ kind: "worktreeNew", detail: "pay" });
  });

  test("asks before making one in another workspace", async () => {
    const app = fakeApp();
    const result = await nexus(app, ["worktree", "new", "x", "--workspace", "api"]);
    expect(result.stderr).toBe("nexus: the user did not allow it\n");
    expect(app.asked[0]).toMatchObject({ toWorkspaceId: API });
    expect(uiArgs(app, "task.create")).toBeUndefined();
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
