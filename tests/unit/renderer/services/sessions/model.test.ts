/**
 * The sessions tab's model: a workspace with its tasks and the agent
 * sessions in their terminals, each in a phase, and which one to show first.
 */
import { describe, expect, it } from "bun:test";
import { resolveSelection } from "../../../../../src/renderer/components/sessions/selection";
import {
  buildFamily,
  estimatedGlyph,
  type FamilyInput,
  firstSession,
  phaseCounts,
  phaseOf,
  workspaceEstimatedGlyph,
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

describe("the tab bar and sidebar glyphs of agents told by their output", () => {
  const codex = terminal("c", "codex");
  const busy = { lastOutputAt: NOW - 500 };
  const done = { lastOutputAt: NOW - 9_500, lastNotice: { body: "5", at: NOW - 10_000 } };

  it("shows running while the agent prints and a done turn until it is looked at", () => {
    expect(estimatedGlyph(codex, busy, undefined, NOW, false)).toBe("running");
    expect(estimatedGlyph(codex, done, undefined, NOW, false)).toBe("completed");
    expect(estimatedGlyph(codex, done, NOW - 20_000, NOW, false)).toBe("completed");
    expect(estimatedGlyph(codex, done, NOW - 1_000, NOW, false)).toBeNull();
  });

  it("counts a turn that ends in front of the user as looked at", () => {
    expect(estimatedGlyph(codex, done, undefined, NOW, true)).toBeNull();
    expect(estimatedGlyph(codex, busy, undefined, NOW, true)).toBe("running");
  });

  it("shows nothing for a quiet agent, a shell, or an ended terminal", () => {
    expect(estimatedGlyph(codex, { lastOutputAt: NOW - 10_000 }, undefined, NOW, false)).toBeNull();
    expect(estimatedGlyph(terminal("s", "zsh"), busy, undefined, NOW, false)).toBeNull();
    expect(estimatedGlyph(terminal("x", "codex", true), busy, undefined, NOW, false)).toBeNull();
    expect(estimatedGlyph(codex, undefined, undefined, NOW, false)).toBeNull();
  });

  it("gives a workspace the strongest glyph of its and its tasks' terminals Claude has no state for", () => {
    const tabs = {
      [ROOT]: { run: terminal("run", "codex"), claude: terminal("claude", "claude") },
      [TASK]: { done: terminal("done", "codex") },
    };
    const sessions = {
      tabsByWorkspace: tabs,
      claudeByWorkspace: { [ROOT]: { claude: claude("idle") } },
      activity: new Map([
        [`${ROOT}:run`, busy],
        // Claude's own terminal prints too; its hooks tell its state.
        [`${ROOT}:claude`, busy],
        [`${TASK}:done`, done],
      ]),
      now: NOW,
      seenByWorkspace: {},
    };
    expect(workspaceEstimatedGlyph(sessions, [ROOT], null)).toBe("running");
    expect(workspaceEstimatedGlyph(sessions, [ROOT, TASK], null)).toBe("completed");
    expect(workspaceEstimatedGlyph(sessions, [ROOT, TASK], `${TASK}:done`)).toBe("running");
    const claudeOnly = { ...sessions, activity: new Map([[`${ROOT}:claude`, busy]]) };
    expect(workspaceEstimatedGlyph(claudeOnly, [ROOT, TASK], null)).toBeNull();
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
