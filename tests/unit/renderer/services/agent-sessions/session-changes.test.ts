/**
 * The sessions' state changes nexus events tells: from two reads of every
 * workspace's sessions, one that appeared at work, changed state, or whose
 * tab went.
 */
import { describe, expect, it } from "bun:test";
import {
  markSessions,
  type SessionMark,
  sessionChanges,
} from "../../../../../src/renderer/services/agent-sessions/session-changes";
import type { Tab } from "../../../../../src/renderer/state/stores/tabs";
import type { StatusEntry } from "../../../../../src/shared/claude/status";
import type { WorkspaceMeta } from "../../../../../src/shared/types/workspace";

const APP = "00000000-0000-4000-8000-000000000001";
const AT = 50_000;

const app = {
  id: APP,
  name: "app",
  location: { kind: "local", rootPath: "/w/app" },
  rootPath: "/w/app",
  colorTone: "default",
  pinned: false,
  tabs: [],
  sortOrder: 0,
  pinnedSortOrder: 0,
} as unknown as WorkspaceMeta;

function terminal(id: string, title: string): Tab {
  return {
    id,
    type: "terminal",
    title,
    defaultTitle: title,
    isPreview: false,
    isPinned: false,
    props: { cwd: "/" },
  } as Tab;
}

function mark(tabId: string, state: string, phase: string, message?: string): SessionMark {
  return {
    workspaceId: APP,
    tabId,
    title: `tab ${tabId}`,
    kind: "terminal",
    agent: "claude",
    state,
    phase,
    message,
  };
}

const marks = (...list: SessionMark[]) => new Map(list.map((m) => [`${APP}:${m.tabId}`, m]));

describe("markSessions", () => {
  it("marks every workspace's agent sessions by key, as the agent view reads them", () => {
    const status = {
      workspaceId: APP,
      tabId: "t1",
      status: "permissionPending",
      since: 1_000,
      message: "Bash: npm test",
    } as StatusEntry;
    const read = markSessions([app], {
      tabsByWorkspace: {
        [APP]: { t1: terminal("t1", "✳ Claude Code"), t2: terminal("t2", "zsh") },
      },
      claudeByWorkspace: { [APP]: { t1: status } },
      activity: new Map(),
      now: 2_000,
    });
    expect([...read.entries()]).toEqual([
      [
        `${APP}:t1`,
        {
          workspaceId: APP,
          tabId: "t1",
          title: "✳ Claude Code",
          kind: "terminal",
          agent: "claude",
          state: "permissionPending",
          phase: "attention",
          message: "Bash: npm test",
        },
      ],
    ]);
  });
});

describe("sessionChanges", () => {
  it("tells a session whose state changed, numbered on from seq, with its message", () => {
    const prev = marks(mark("t1", "running", "running"), mark("t2", "running", "running"));
    const next = marks(
      mark("t1", "completed", "done", "Fixed it."),
      mark("t2", "running", "running", "still at it"),
    );
    expect(sessionChanges(prev, next, AT, 7)).toEqual([
      {
        seq: 7,
        at: AT,
        workspaceId: APP,
        tabId: "t1",
        title: "tab t1",
        kind: "terminal",
        agent: "claude",
        from: "running",
        to: "completed",
        phase: "done",
        message: "Fixed it.",
      },
    ]);
  });

  it("tells one that appeared at work, not one that appeared at rest", () => {
    const next = marks(mark("t1", "running", "running"), mark("t2", "idle", "idle"));
    expect(sessionChanges(new Map(), next, AT, 1).map((e) => [e.tabId, e.from, e.to])).toEqual([
      ["t1", null, "running"],
    ]);
  });

  it("tells one whose tab went as closed, after the others, without its message", () => {
    const prev = marks(mark("t1", "completed", "done", "Fixed it."), mark("t2", "idle", "idle"));
    const next = marks(mark("t2", "running", "running"));
    const events = sessionChanges(prev, next, AT, 3);
    expect(events.map((e) => [e.seq, e.tabId, e.from, e.to, e.phase])).toEqual([
      [3, "t2", "idle", "running", "running"],
      [4, "t1", "completed", "closed", "closed"],
    ]);
    expect(events[1]?.message).toBeUndefined();
  });

  it("tells a goal set or changing status, with the state or alone; not one that went", () => {
    const goal = (status: string) => ({ objective: "All tests pass", status });
    const prev = new Map([
      ["a", mark("a", "running", "running")],
      ["b", { ...mark("b", "completed", "done"), goal: goal("active") }],
      ["c", { ...mark("c", "completed", "done"), goal: goal("met") }],
    ]);
    const next = new Map([
      ["a", { ...mark("a", "completed", "done"), goal: goal("active") }],
      ["b", { ...mark("b", "completed", "done"), goal: goal("met") }],
      ["c", mark("c", "completed", "done")],
    ]);
    const events = sessionChanges(prev, next, AT, 1);
    expect(events.map((e) => [e.tabId, e.from, e.to, e.goal])).toEqual([
      ["a", "running", "completed", { objective: "All tests pass", from: null, status: "active" }],
      [
        "b",
        "completed",
        "completed",
        { objective: "All tests pass", from: "active", status: "met" },
      ],
    ]);
  });

  it("tells nothing when nothing changed", () => {
    const same = marks(mark("t1", "running", "running"));
    expect(sessionChanges(same, same, AT, 1)).toEqual([]);
  });
});
