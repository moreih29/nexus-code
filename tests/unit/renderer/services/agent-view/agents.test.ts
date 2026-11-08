/**
 * The agent view's list: every workspace's agents under it, its tasks with
 * it, pinned workspaces first; the counts its filters show; and the color
 * that ties a workspace's agents in the panels to it.
 */
import { describe, expect, it } from "bun:test";
import {
  type AgentsInput,
  agentCounts,
  buildAgents,
  passesFilter,
  sameAgents,
  workspaceColor,
} from "../../../../../src/renderer/services/agent-view/agents";
import type { Tab } from "../../../../../src/renderer/state/stores/tabs";
import type { StatusEntry } from "../../../../../src/shared/claude/status";
import type { WorkspaceMeta } from "../../../../../src/shared/types/workspace";

const APP = "00000000-0000-4000-8000-000000000001";
const TASK = "00000000-0000-4000-8000-000000000002";
const DOCS = "00000000-0000-4000-8000-000000000003";

function workspace(id: string, name: string, extra: Partial<WorkspaceMeta> = {}): WorkspaceMeta {
  return {
    id,
    name,
    location: { kind: "local", rootPath: `/w/${name}` },
    rootPath: `/w/${name}`,
    colorTone: "default",
    pinned: false,
    lastOpenedAt: new Date(0).toISOString(),
    tabs: [],
    sortOrder: 0,
    pinnedSortOrder: 0,
    ...extra,
  } as WorkspaceMeta;
}

function claudeTab(id: string): Tab {
  return {
    id,
    type: "claude",
    title: `claude ${id}`,
    defaultTitle: "Claude",
    isPreview: false,
    isPinned: false,
    props: { cwd: "/" },
  } as Tab;
}

/** A terminal whose Claude ended with it. */
function deadTerminal(id: string): Tab {
  return {
    id,
    type: "terminal",
    title: `terminal ${id}`,
    defaultTitle: "Terminal",
    isPreview: false,
    isPinned: false,
    props: { cwd: "/", dead: true },
  } as unknown as Tab;
}

function status(value: StatusEntry["status"]): StatusEntry {
  return { workspaceId: "", tabId: "", status: value, since: 1_000 } as StatusEntry;
}

function input(): AgentsInput {
  return {
    workspaces: [
      workspace(APP, "app"),
      workspace(TASK, "fix-login", {
        task: { parentId: APP, branch: "task/fix-login", worktreePath: "/w/t" },
      }),
      workspace(DOCS, "docs", { pinned: true }),
    ],
    tabsByWorkspace: {
      [APP]: { a1: claudeTab("a1"), a2: claudeTab("a2") },
      [TASK]: { t1: claudeTab("t1") },
      [DOCS]: {},
    },
    claudeByWorkspace: {
      [APP]: { a1: status("running"), a2: status("permissionPending") },
      [TASK]: { t1: status("completed") },
    },
    activity: new Map(),
    now: 10_000,
    seenByWorkspace: {},
    viewing: null,
  };
}

describe("buildAgents", () => {
  it("lists pinned workspaces first, each with its tasks under it", () => {
    const { families } = buildAgents(input());
    expect(families.map((family) => family.root.name)).toEqual(["docs", "app"]);
    expect(families[1]?.worktrees.map((w) => [w.workspace.name, w.isRoot, w.branch])).toEqual([
      ["app", true, undefined],
      ["fix-login", false, "task/fix-login"],
    ]);
  });

  it("finds each agent by its session key, with the workspace it is listed under", () => {
    const { byKey } = buildAgents(input());
    expect([...byKey.keys()]).toEqual([`${APP}:a1`, `${APP}:a2`, `${TASK}:t1`]);
    const task = byKey.get(`${TASK}:t1`);
    expect(task?.workspace.id).toBe(TASK);
    expect(task?.root.id).toBe(APP);
  });

  it("tells a rebuild that lists the same from one that changed", () => {
    const base = input();
    expect(sameAgents(buildAgents(base), buildAgents({ ...base, now: 20_000 }))).toBe(true);
    const changed: AgentsInput = {
      ...base,
      claudeByWorkspace: {
        ...base.claudeByWorkspace,
        [APP]: { a1: status("completed"), a2: status("permissionPending") },
      },
    };
    expect(sameAgents(buildAgents(base), buildAgents(changed))).toBe(false);
  });
});

describe("agentCounts", () => {
  it("counts every agent, and those in each group of the agents tab", () => {
    expect(agentCounts(buildAgents(input()))).toEqual({
      all: 3,
      running: 1,
      attention: 1,
      done: 1,
      idle: 0,
    });
  });

  it("counts an agent done with, or not yet started, as idle; one ended in none", () => {
    const base = input();
    const agents = buildAgents({
      ...base,
      tabsByWorkspace: {
        ...base.tabsByWorkspace,
        [DOCS]: { d1: claudeTab("d1"), d2: claudeTab("d2"), d3: deadTerminal("d3") },
      },
      claudeByWorkspace: {
        ...base.claudeByWorkspace,
        [DOCS]: { d1: status("idle"), d3: status("running") },
      },
    });
    expect(agentCounts(agents)).toEqual({
      all: 6,
      running: 1,
      attention: 1,
      done: 1,
      idle: 2,
    });
    const ended = agents.byKey.get(`${DOCS}:d3`)?.session;
    expect(ended?.state).toBe("exited");
    for (const filter of ["running", "attention", "done", "idle"] as const) {
      expect(ended && passesFilter(ended, filter)).toBe(false);
    }
    expect(ended && passesFilter(ended, "all")).toBe(true);
  });
});

describe("workspaceColor", () => {
  it("gives a workspace one of the theme's lane colors, the same every time", () => {
    const color = workspaceColor(APP);
    expect(color).toMatch(/^var\(--color-git-lane-[0-7]\)$/);
    expect(workspaceColor(APP)).toBe(color);
  });
});
