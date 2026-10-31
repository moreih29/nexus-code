/**
 * Tasks on the renderer side: creating one switches to it and has its
 * terminal start the agent; failures come back as the IPC kind and message.
 */
import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";
import type { WorkspaceMeta } from "../../../../src/shared/types/workspace";

const PARENT = "00000000-0000-4000-8000-000000000001";
const TASK = "00000000-0000-4000-8000-000000000002";

const CLIENT = "../../../../src/renderer/ipc/client";
const OPEN_TERMINAL = "../../../../src/renderer/services/terminal/open-terminal";
const PTY_CLIENT = "../../../../src/renderer/services/terminal/pty-client";

// Module mocks are process-wide: this file puts back what it found when it
// is done, so later files get the real modules.
const previous = {
  client: { ...(await import(CLIENT)) },
  openTerminal: { ...(await import(OPEN_TERMINAL)) },
  ptyClient: { ...(await import(PTY_CLIENT)) },
};
afterAll(() => {
  mock.module(CLIENT, () => previous.client);
  mock.module(OPEN_TERMINAL, () => previous.openTerminal);
  mock.module(PTY_CLIENT, () => previous.ptyClient);
});

const calls: Array<{ method: string; args: unknown }> = [];
let createResult: unknown;
let removeResults: unknown[] = [];

mock.module(CLIENT, () => ({
  ...previous.client,
  ipcCallResult: (_channel: string, method: string, args: unknown) => {
    calls.push({ method, args });
    if (method === "create") return Promise.resolve(createResult);
    if (method === "remove") return Promise.resolve(removeResults.shift());
    return Promise.resolve({ ok: true, value: undefined });
  },
}));

const opened: Array<{ workspaceId: string; cwd: string }> = [];
mock.module(OPEN_TERMINAL, () => ({
  ...previous.openTerminal,
  openTerminal: (input: { workspaceId: string; cwd: string }) => {
    opened.push(input);
    return { groupId: "group", tabId: "tab-1" };
  },
}));

const startup: Array<{ tabId: string; line: string }> = [];
mock.module(PTY_CLIENT, () => ({
  ...previous.ptyClient,
  queueStartupInput: (_ws: string, tabId: string, build: (shellPath?: string) => string) => {
    startup.push({ tabId, line: build("/bin/zsh") });
  },
}));

const { agentCommandLine, createTask, removeTask } = await import(
  "../../../../src/renderer/services/workspace/tasks"
);
const { useActiveStore } = await import("../../../../src/renderer/state/stores/active");
const { useTerminalStore } = await import("../../../../src/renderer/state/stores/terminal");
const { useWorkspacesStore } = await import("../../../../src/renderer/state/stores/workspaces");

const task: WorkspaceMeta = {
  id: TASK,
  name: "fix login",
  location: { kind: "local", rootPath: "/w/repo-abc123/fix-login" },
  rootPath: "/w/repo-abc123/fix-login",
  colorTone: "default",
  pinned: false,
  tabs: [],
  sortOrder: 0,
  pinnedSortOrder: 0,
  task: { parentId: PARENT, branch: "fix-login", worktreePath: "/w/repo-abc123/fix-login" },
};

beforeEach(() => {
  calls.length = 0;
  opened.length = 0;
  startup.length = 0;
  useWorkspacesStore.setState({ workspaces: [] });
  useActiveStore.getState().setActiveWorkspaceId(PARENT);
  useTerminalStore.setState({ taskAgentCommand: undefined });
});

describe("agentCommandLine", () => {
  it("runs the command with the prompt as one argument", () => {
    expect(agentCommandLine("claude", " fix it's login ", "/bin/zsh")).toBe(
      "claude 'fix it'\\''s login'\r",
    );
  });

  it("runs the command alone without a prompt, and nothing without a command", () => {
    expect(agentCommandLine("claude", "  ")).toBe("claude\r");
    expect(agentCommandLine("", "fix it")).toBeNull();
  });
});

describe("createTask", () => {
  it("switches to the task and starts the agent in its terminal", async () => {
    createResult = { ok: true, value: task };

    expect(await createTask(PARENT, "fix login", "fix the redirect")).toBeNull();

    expect(calls[0]).toEqual({ method: "create", args: { parentId: PARENT, name: "fix login" } });
    expect(useWorkspacesStore.getState().workspaces.map((w) => w.id)).toEqual([TASK]);
    expect(opened).toEqual([{ workspaceId: TASK, cwd: task.rootPath }]);
    expect(startup).toEqual([{ tabId: "tab-1", line: "claude 'fix the redirect'\r" }]);
    expect(useActiveStore.getState().activeWorkspaceId).toBe(TASK);
    expect(calls.at(-1)).toEqual({ method: "activate", args: { id: TASK } });
  });

  it("opens a plain terminal when the agent command is empty", async () => {
    createResult = { ok: true, value: task };
    useTerminalStore.setState({ taskAgentCommand: "" });

    await createTask(PARENT, "fix login", "fix the redirect");

    expect(opened).toHaveLength(1);
    expect(startup).toEqual([]);
  });

  it("returns a failure and stays put", async () => {
    createResult = { ok: false, kind: "not-a-repo", message: "/w is not in a git repository" };

    expect(await createTask(PARENT, "fix login", "")).toEqual({
      kind: "not-a-repo",
      message: "/w is not in a git repository",
    });
    expect(opened).toEqual([]);
    expect(useActiveStore.getState().activeWorkspaceId).toBe(PARENT);
  });
});

describe("removeTask", () => {
  it("passes the options through and returns the failure kind", async () => {
    removeResults = [{ ok: false, kind: "worktree-dirty", message: "has changes" }];

    expect(await removeTask(TASK, { force: false, deleteBranch: true })).toEqual({
      kind: "worktree-dirty",
      message: "has changes",
    });
    expect(calls).toEqual([
      { method: "remove", args: { id: TASK, force: false, deleteBranch: true } },
    ]);
  });
});
