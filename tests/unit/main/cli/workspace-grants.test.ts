import { expect, test } from "bun:test";
import { CLI_COMMANDS } from "../../../../src/main/features/cli/commands";
import { runCli } from "../../../../src/main/features/cli/registry";
import { ipcContract } from "../../../../src/shared/ipc/contract";
import { AppStateSchema } from "../../../../src/shared/types/app-state";
import {
  API,
  APP,
  CLAUDE_TAB,
  contextFor,
  type FakeApp,
  FIX,
  fakeApp,
  NEW_TAB,
} from "./fake-services";

const caller = { workspaceId: API, tabId: CLAUDE_TAB, verified: true };
const create = ["worktree", "new", "qa-branch", "--workspace", APP, "--command="];
const remove = ["worktree", "remove", FIX, "--workspace", APP];

function fixture() {
  const app = fakeApp();
  for (const id of [CLAUDE_TAB, NEW_TAB]) {
    app.tabs[API]?.push({ id, type: "claude", title: id, groupId: "chat", shown: false });
  }
  return app;
}

function run(app: FakeApp, command: string[], source = caller) {
  return runCli(CLI_COMMANDS, contextFor(app, command, source));
}

test("a grant from a worktree covers its parent and new worktrees, for the calling session", async () => {
  const app = fixture();
  app.answers.push("session");
  expect((await run(app, remove)).exitCode).toBe(0);
  expect((await run(app, create)).exitCode).toBe(0);
  const workspaces = app.services.listWorkspaces();
  const original = workspaces.find(({ id }) => id === FIX);
  if (!original?.task) throw new Error("missing worktree fixture");
  const id = crypto.randomUUID();
  workspaces.push({ ...original, id, task: { ...original.task, branch: "qa-new" } });
  const removeNew = ["worktree", "remove", id, "--workspace", APP];
  expect((await run(app, removeNew)).exitCode).toBe(0);
  expect(app.asked).toHaveLength(1);
  expect((await run(app, removeNew, { ...caller, tabId: NEW_TAB })).exitCode).toBe(1);
  expect((await run(app, removeNew, { ...caller, verified: false })).exitCode).toBe(1);
  const [grant] = await app.consent.grants();
  expect(grant).toMatchObject({ workspaceId: APP, fromWorkspaceId: API, fromTabId: CLAUDE_TAB });
  if (!grant) throw new Error("missing session grant");
  app.consent.revoke(grant.id);
  expect(await app.consent.grants()).toEqual([]);
  expect((await run(app, removeNew)).exitCode).toBe(1);
});

test("pre-approval applies to callers across sessions and their destination worktrees", async () => {
  const app = fixture();
  app.settings.preallowedWorkspaces = [APP];
  expect((await run(app, create)).exitCode).toBe(0);
  expect((await run(app, remove, { ...caller, tabId: NEW_TAB })).exitCode).toBe(0);
  expect(app.asked).toHaveLength(0);
  app.settings.preallowedWorkspaces = [];
  expect((await run(app, remove)).exitCode).toBe(1);
});

test("deny overrides both grants, including a policy change while a prompt waits", async () => {
  const app = fixture();
  app.answers.push("session");
  expect((await run(app, remove)).exitCode).toBe(0);
  app.settings.preallowedWorkspaces = [APP];
  app.settings.crossWorkspace = "deny";
  expect((await run(app, create)).stderr).toContain("changing other workspaces is turned off");
  expect(app.asked).toHaveLength(1);

  const pending = fixture();
  pending.answers.shift = () => {
    pending.settings.crossWorkspace = "deny";
    return "session";
  };
  expect((await run(pending, create)).stderr).toContain("changing other workspaces is turned off");
  expect(await pending.consent.grants()).toEqual([]);
  expect(pending.uiCalls.some(({ op }) => op === "task.create")).toBe(false);
});

test("a new conversation in the same tab cannot use or finish an old session's approval", async () => {
  const app = fixture();
  let session = "old";
  app.uiAnswers.set("tab.sandboxSession", () => session);
  app.answers.push("session");
  expect((await run(app, remove)).exitCode).toBe(0);
  session = "new";
  expect(await app.consent.grants()).toEqual([]);
  expect((await run(app, remove)).exitCode).toBe(1);
  app.answers.shift = () => {
    session = "changed-during-approval";
    return "session";
  };
  expect((await run(app, create)).stderr).toContain("calling chat session changed");
  expect(await app.consent.grants()).toEqual([]);
});

test("a workspace grant cannot answer the agent's own approval", async () => {
  const app = fixture();
  app.settings.preallowedWorkspaces = [APP, API];
  const result = await run(app, ["chat", "answer", CLAUDE_TAB, "allow"]);
  expect(result.stderr).toContain("its requests are the user's to answer");
  expect(app.uiCalls.some(({ op }) => op === "chat.answer" || op === "consent.settle")).toBe(false);
});

test("cross-workspace approval timeout returns a result without changing the workspace", async () => {
  const app = fixture();
  app.answers.push("timeout");
  const result = await run(app, [...create, "--json"]);
  expect(result.exitCode).toBe(1);
  expect(JSON.parse(result.stdout)).toMatchObject({ error: "approval-timeout" });
  expect(app.uiCalls.some(({ op }) => op === "task.create")).toBe(false);
});

test("older app state starts without grants and generic settings updates cannot write grants", () => {
  expect(AppStateSchema.parse({ cliCrossWorkspace: "ask" }).cliPreallowedWorkspaces).toEqual([]);
  expect(AppStateSchema.parse({ cliPreallowedWorkspaces: [APP] }).cliPreallowedWorkspaces).toEqual([
    APP,
  ]);
  expect(ipcContract.appState.call.set.args.parse({ cliPreallowedWorkspaces: [APP] })).toEqual({});
});
