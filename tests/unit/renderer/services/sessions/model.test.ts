/**
 * The sessions tab's model: a workspace with its tasks and the agent
 * sessions in their terminals, each in a phase, and which one to show first.
 */
import { describe, expect, it } from "bun:test";
import { emptyTabState } from "../../../../../src/renderer/services/chat/store";
import { buildFamily, type FamilyInput } from "../../../../../src/renderer/services/sessions/model";
import type { Tab } from "../../../../../src/renderer/state/stores/tabs";
import type { StatusEntry } from "../../../../../src/shared/claude/status";
import type { TabActivity } from "../../../../../src/shared/sessions/agent-state";
import type { WorkspaceMeta } from "../../../../../src/shared/types/workspace";

const ROOT = "00000000-0000-4000-8000-000000000001";
const TASK = "00000000-0000-4000-8000-000000000002";
const OTHER = "00000000-0000-4000-8000-000000000003";
const NOW = 100_000;

function workspace(id: string, task?: WorkspaceMeta["task"]): WorkspaceMeta {
  return {
    id,
    name: id === ROOT ? "app" : id === TASK ? "fix-login" : "other",
    location: { kind: "local", rootPath: `/w/${id}` },
    rootPath: `/w/${id}`,
    colorTone: "default",
    pinned: false,
    lastOpenedAt: new Date(0).toISOString(),
    tabs: [],
    sortOrder: 0,
    pinnedSortOrder: 0,
    ...(task ? { task } : {}),
  } as WorkspaceMeta;
}

function terminal(id: string, title: string, dead = false): Tab {
  return {
    id,
    type: "terminal",
    title,
    defaultTitle: title,
    isPreview: false,
    isPinned: false,
    props: { cwd: "/", ...(dead ? { dead } : {}) },
  } as Tab;
}

function claudeTab(id: string, title: string): Tab {
  return {
    id,
    type: "claude",
    title,
    defaultTitle: title,
    isPreview: false,
    isPinned: false,
    props: { cwd: "/" },
  } as Tab;
}

function codexTab(id: string, title: string): Tab {
  return { ...claudeTab(id, title), type: "codex" } as Tab;
}

function claude(status: StatusEntry["status"], extra: Partial<StatusEntry> = {}): StatusEntry {
  return { workspaceId: "", tabId: "", status, since: 1_000, ...extra } as StatusEntry;
}

const workspaces = [
  workspace(ROOT),
  workspace(TASK, { parentId: ROOT, branch: "task/fix-login", worktreePath: "/w/t" }),
  workspace(OTHER),
];

function input(overrides: Partial<FamilyInput> = {}): FamilyInput {
  return {
    workspaces,
    workspaceId: ROOT,
    tabsByWorkspace: {},
    claudeByWorkspace: {},
    activity: new Map<string, TabActivity>(),
    now: NOW,
    ...overrides,
  };
}

describe("buildFamily", () => {
  it("lists Claude tabs as Claude sessions, idle until their hooks tell", () => {
    const family = buildFamily(
      input({
        tabsByWorkspace: {
          [ROOT]: { k: claudeTab("k", "Fix login"), n: claudeTab("n", "Claude") },
        },
        claudeByWorkspace: {
          [ROOT]: { k: claude("permissionPending", { message: "Bash", prompt: "fix it" }) },
        },
      }),
    );
    const [asking, fresh] = family?.worktrees[0].sessions ?? [];
    expect(asking).toMatchObject({
      key: `${ROOT}:k`,
      kind: "claude",
      title: "Fix login",
      agent: "claude",
      state: "permissionPending",
      phase: "attention",
      estimated: false,
      message: "Bash",
      prompt: "fix it",
    });
    expect(fresh).toMatchObject({ kind: "claude", state: "idle", phase: "idle" });
  });

  it("lists Codex tabs as Codex sessions, in the state their conversation tells", () => {
    const empty = emptyTabState();
    const family = buildFamily(
      input({
        tabsByWorkspace: { [ROOT]: { x: codexTab("x", "Codex"), y: codexTab("y", "Codex") } },
        chats: {
          [`${ROOT}:x`]: {
            ...empty,
            phase: "ready",
            model: {
              ...empty.model,
              running: true,
              turn: { startedAt: 2_000, outputTokens: 0, thinkingTokens: 0 },
            },
          },
        },
      }),
    );
    const [running, fresh] = family?.worktrees[0].sessions ?? [];
    expect(running).toMatchObject({
      key: `${ROOT}:x`,
      kind: "codex",
      agent: "codex",
      state: "running",
      phase: "running",
      estimated: false,
      since: 2_000,
    });
    // Its view not shown since the app started: nothing tells it yet.
    expect(fresh).toMatchObject({ kind: "codex", state: "idle", phase: "idle" });
  });

  it("lists only terminals running an agent, with Claude's state and last prompt", () => {
    const family = buildFamily(
      input({
        tabsByWorkspace: {
          [ROOT]: { a: terminal("a", "✳ Claude Code"), shell: terminal("shell", "zsh") },
          [TASK]: { c: terminal("c", "codex") },
        },
        claudeByWorkspace: {
          [ROOT]: { a: claude("permissionPending", { message: "Bash", prompt: "fix it" }) },
        },
        activity: new Map([[`${TASK}:c`, { lastOutputAt: NOW - 500 }]]),
      }),
    );
    const [root, task] = family?.worktrees ?? [];
    expect(root.sessions).toHaveLength(1);
    expect(root.sessions[0]).toMatchObject({
      key: `${ROOT}:a`,
      kind: "terminal",
      agent: "claude",
      state: "permissionPending",
      phase: "attention",
      estimated: false,
      message: "Bash",
      prompt: "fix it",
      since: 1_000,
    });
    expect(task.sessions[0]).toMatchObject({
      key: `${TASK}:c`,
      agent: "codex",
      state: "busy",
      phase: "running",
      estimated: true,
      since: NOW - 500,
    });
  });

  it("tells a quiet agent from a busy one, and an ended terminal from both", () => {
    const family = buildFamily(
      input({
        tabsByWorkspace: {
          [ROOT]: { q: terminal("q", "codex"), x: terminal("x", "codex", true) },
        },
        activity: new Map([[`${ROOT}:q`, { lastOutputAt: NOW - 10_000 }]]),
      }),
    );
    const states = family?.worktrees[0].sessions.map((s) => [s.tabId, s.state, s.phase]);
    expect(states).toEqual([
      ["q", "quiet", "idle"],
      ["x", "exited", "idle"],
    ]);
  });

  it("shows an agent quiet since it notified as done, and as idle once it printed more", () => {
    const notice = { body: "5", at: NOW - 10_000 };
    const family = buildFamily(
      input({
        tabsByWorkspace: {
          [ROOT]: { done: terminal("done", "codex"), later: terminal("later", "codex") },
        },
        activity: new Map([
          // Its prompt redrawn just after the notification.
          [`${ROOT}:done`, { lastOutputAt: NOW - 9_500, lastNotice: notice }],
          // A turn since, which ended without one.
          [`${ROOT}:later`, { lastOutputAt: NOW - 5_000, lastNotice: notice }],
        ]),
      }),
    );
    const states = family?.worktrees[0].sessions.map((s) => [s.tabId, s.state, s.phase]);
    expect(states).toEqual([
      ["done", "completed", "done"],
      ["later", "quiet", "idle"],
    ]);
  });

  it("shows an agent's done turn as idle once its terminal was looked at", () => {
    const notice = { body: "5", at: NOW - 10_000 };
    const done = { lastOutputAt: NOW - 9_500, lastNotice: notice };
    const family = buildFamily(
      input({
        tabsByWorkspace: {
          [ROOT]: {
            seen: terminal("seen", "codex"),
            before: terminal("before", "codex"),
            never: terminal("never", "codex"),
            claude: terminal("claude", "claude"),
          },
        },
        claudeByWorkspace: { [ROOT]: { claude: claude("completed", { since: NOW - 10_000 }) } },
        activity: new Map([
          [`${ROOT}:seen`, done],
          [`${ROOT}:before`, done],
          [`${ROOT}:never`, done],
        ]),
        seenByWorkspace: {
          // Looked at after the turn ended; before it ended; Claude's own state.
          [ROOT]: { seen: NOW - 1_000, before: NOW - 20_000, claude: NOW - 1_000 },
        },
      }),
    );
    const states = family?.worktrees[0].sessions.map((s) => [s.tabId, s.state, s.phase]);
    expect(states).toEqual([
      ["seen", "quiet", "idle"],
      ["before", "completed", "done"],
      ["never", "completed", "done"],
      // Claude's completed is cleared by markSeen in main, not here.
      ["claude", "completed", "done"],
    ]);
  });

  it("counts an agent known only by its notifications", () => {
    const family = buildFamily(
      input({
        tabsByWorkspace: { [ROOT]: { n: terminal("n", "node") } },
        activity: new Map([
          [`${ROOT}:n`, { lastOutputAt: 5, lastNotice: { title: "Agent", body: "done", at: 6 } }],
        ]),
      }),
    );
    expect(family?.worktrees[0].sessions[0]).toMatchObject({
      agent: undefined,
      message: "Agent: done",
      since: 6,
    });
  });

  it("knows Codex by its process, as its title names only its task and folder", () => {
    const family = buildFamily(
      input({
        tabsByWorkspace: {
          [ROOT]: { c: terminal("c", "README 요약 | app"), s: terminal("s", "bash") },
        },
        activity: new Map([
          [`${ROOT}:c`, { lastOutputAt: NOW - 10_000, program: "codex" }],
          [`${ROOT}:s`, { lastOutputAt: NOW - 10_000, program: "bash" }],
        ]),
      }),
    );
    expect(family?.worktrees[0].sessions.map((s) => [s.tabId, s.agent, s.state])).toEqual([
      ["c", "codex", "quiet"],
    ]);
  });

  it("counts no agent by a title the shell kept once it is back in front", () => {
    const family = buildFamily(
      input({
        tabsByWorkspace: {
          [ROOT]: {
            gone: terminal("gone", "✳ Claude Code"),
            up: terminal("up", "✳ Claude Code"),
          },
        },
        activity: new Map([
          [`${ROOT}:gone`, { lastOutputAt: NOW - 10_000, program: "-zsh" }],
          [`${ROOT}:up`, { lastOutputAt: NOW - 10_000, program: "node" }],
        ]),
      }),
    );
    expect(family?.worktrees[0].sessions.map((s) => [s.tabId, s.agent])).toEqual([
      ["up", "claude"],
    ]);
  });
});
