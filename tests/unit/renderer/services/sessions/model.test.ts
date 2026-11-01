/**
 * The sessions tab's model: a workspace with its tasks and the agent
 * sessions in their terminals, each in a phase, and which one to show first.
 */
import { describe, expect, it } from "bun:test";
import { resolveSelection } from "../../../../../src/renderer/components/sessions/selection";
import {
  buildFamily,
  type FamilyInput,
  firstSession,
  phaseCounts,
  phaseOf,
} from "../../../../../src/renderer/services/sessions/model";
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

describe("phaseOf", () => {
  it("puts what waits on the user first, then work, done and the rest", () => {
    expect(phaseOf("permissionPending")).toBe("attention");
    expect(phaseOf("needsInput")).toBe("attention");
    expect(phaseOf("error")).toBe("attention");
    expect(phaseOf("running")).toBe("running");
    expect(phaseOf("busy")).toBe("running");
    expect(phaseOf("completed")).toBe("done");
    expect(phaseOf("idle")).toBe("idle");
    expect(phaseOf("quiet")).toBe("idle");
    expect(phaseOf("exited")).toBe("idle");
  });
});

describe("buildFamily", () => {
  it("is the workspace and its tasks, whichever of them the tab is in", () => {
    const fromRoot = buildFamily(input());
    const fromTask = buildFamily(input({ workspaceId: TASK }));
    for (const family of [fromRoot, fromTask]) {
      expect(family?.root.id).toBe(ROOT);
      expect(family?.worktrees.map((w) => [w.workspace.id, w.isRoot, w.branch])).toEqual([
        [ROOT, true, undefined],
        [TASK, false, "task/fix-login"],
      ]);
    }
  });

  it("is null for a workspace that is gone", () => {
    expect(buildFamily(input({ workspaceId: "gone" }))).toBeNull();
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
});

describe("what to show first", () => {
  const family = buildFamily(
    input({
      tabsByWorkspace: {
        [ROOT]: { idle: terminal("idle", "claude"), run: terminal("run", "claude") },
        [TASK]: { done: terminal("done", "claude"), ask: terminal("ask", "claude") },
      },
      claudeByWorkspace: {
        [ROOT]: { idle: claude("idle"), run: claude("running") },
        [TASK]: { done: claude("completed"), ask: claude("needsInput") },
      },
    }),
  );
  if (!family) throw new Error("no family");

  it("counts each phase", () => {
    expect(phaseCounts(family)).toEqual({ attention: 1, running: 1, done: 1, idle: 1 });
  });

  it("starts with a session waiting on the user", () => {
    expect(firstSession(family)?.tabId).toBe("ask");
    expect(resolveSelection(family, null)).toEqual({ kind: "session", key: `${TASK}:ask` });
  });

  it("keeps a selection that still names something", () => {
    const session = { kind: "session", key: `${ROOT}:idle` } as const;
    const worktree = { kind: "worktree", workspaceId: TASK } as const;
    expect(resolveSelection(family, session)).toBe(session);
    expect(resolveSelection(family, worktree)).toBe(worktree);
  });

  it("moves on from a selection that is gone", () => {
    expect(resolveSelection(family, { kind: "session", key: `${ROOT}:closed` })).toEqual({
      kind: "session",
      key: `${TASK}:ask`,
    });
    expect(resolveSelection(family, { kind: "worktree", workspaceId: OTHER })).toEqual({
      kind: "session",
      key: `${TASK}:ask`,
    });
  });

  it("shows the workspace when there are no sessions", () => {
    const empty = buildFamily(input());
    if (!empty) throw new Error("no family");
    expect(firstSession(empty)).toBeUndefined();
    expect(resolveSelection(empty, null)).toEqual({ kind: "worktree", workspaceId: ROOT });
  });
});
