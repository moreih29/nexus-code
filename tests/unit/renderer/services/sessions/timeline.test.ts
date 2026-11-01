/**
 * The timeline view's lanes: a session's recorded spans as bars cut to the
 * period, its waits apart, a lane for a worktree with no session, and round
 * clock times on the axis.
 */
import { describe, expect, it } from "bun:test";
import type {
  AgentSession,
  SessionFamily,
  WorktreeEntry,
} from "../../../../../src/renderer/services/sessions/model";
import {
  buildTimeline,
  failedTools,
  rangeStart,
  ticksBetween,
} from "../../../../../src/renderer/services/sessions/timeline";
import type { SessionSpan } from "../../../../../src/shared/sessions/history";
import type { WorkspaceMeta } from "../../../../../src/shared/types/workspace";

const ROOT = "00000000-0000-4000-8000-000000000001";
const TASK = "00000000-0000-4000-8000-00000000000a";
const MINUTE = 60_000;

function worktree(id: string, tabIds: string[]): WorktreeEntry {
  return {
    workspace: { id, name: id.slice(-2) } as WorkspaceMeta,
    isRoot: id === ROOT,
    branch: undefined,
    sessions: tabIds.map(
      (tabId) =>
        ({
          key: `${id}:${tabId}`,
          workspaceId: id,
          tabId,
          phase: "idle",
          state: "idle",
        }) as AgentSession,
    ),
  };
}

function family(...worktrees: WorktreeEntry[]): SessionFamily {
  return { root: worktrees[0]?.workspace as WorkspaceMeta, worktrees };
}

const span = (
  workspaceId: string,
  tabId: string,
  state: string,
  start: number,
  end: number | null,
  target?: SessionSpan["target"],
): SessionSpan => ({ workspaceId, tabId, state, start, end, ...(target ? { target } : {}) });

describe("buildTimeline", () => {
  const now = 1_000 * MINUTE;
  const from = now - 30 * MINUTE;

  it("cuts a session's spans to the period and runs the open one to now", () => {
    const timeline = buildTimeline(
      family(worktree(ROOT, ["t"])),
      [
        span(ROOT, "t", "idle", from - 10 * MINUTE, from - MINUTE),
        span(ROOT, "t", "running", from - 5 * MINUTE, from + 5 * MINUTE),
        span(ROOT, "t", "permissionPending", from + 5 * MINUTE, null),
      ],
      from,
      now,
    );
    expect(timeline.lanes[0]?.bars).toEqual([
      { state: "running", phase: "running", estimated: false, start: from, end: from + 5 * MINUTE },
      {
        state: "permissionPending",
        phase: "attention",
        estimated: false,
        start: from + 5 * MINUTE,
        end: now,
      },
    ]);
  });

  it("marks output-told spans estimated and keeps waits apart, with the worktree waited on", () => {
    const tree = family(worktree(ROOT, ["t"]), worktree(TASK, ["u"]));
    const timeline = buildTimeline(
      tree,
      [
        span(ROOT, "t", "busy", from, from + MINUTE),
        span(ROOT, "t", "waiting", from + MINUTE, null, { workspaceId: TASK, tabId: "u" }),
      ],
      from,
      now,
    );
    const lane = timeline.lanes[0];
    expect(lane?.bars.map((b) => [b.state, b.phase, b.estimated])).toEqual([
      ["busy", "running", true],
    ]);
    expect(lane?.waits).toEqual([{ start: from + MINUTE, end: now, target: tree.worktrees[1] }]);
    expect(timeline.lanes[1]?.bars).toEqual([]);
  });

  it("keeps a lane for an ended Claude Code session, not for a terminal that only printed", () => {
    const timeline = buildTimeline(
      family(worktree(ROOT, ["t"]), worktree(TASK, [])),
      [
        span(TASK, "gone", "running", from + MINUTE, from + 2 * MINUTE),
        span(TASK, "shell", "busy", from + MINUTE, from + 2 * MINUTE),
        span(ROOT, "old", "completed", from - 9 * MINUTE, from - MINUTE),
      ],
      from,
      now,
    );
    expect(timeline.lanes.map((l) => [l.key, l.session?.tabId, l.agent])).toEqual([
      [`${ROOT}:t`, "t", undefined],
      [`${TASK}:gone`, undefined, "claude"],
    ]);
  });

  it("leaves the spans of a session's agents out of its bars", () => {
    const timeline = buildTimeline(
      family(worktree(ROOT, ["t"])),
      [
        span(ROOT, "t", "running", from, null),
        {
          ...span(ROOT, "t", "permissionPending", from + MINUTE, null),
          agent: { id: "a1", kind: "subagent" },
        },
      ],
      from,
      now,
    );
    expect(timeline.lanes[0]?.bars.map((b) => b.state)).toEqual(["running"]);
  });

  it("puts a session's agents under its lane, each with how it ended", () => {
    const agent = (id: string) => ({ id, kind: "subagent" as const, type: "Explore" });
    const of = (s: SessionSpan, id: string): SessionSpan => ({ ...s, agent: agent(id) });
    const timeline = buildTimeline(
      family(worktree(ROOT, ["t"])),
      [
        span(ROOT, "t", "running", from, null),
        of(span(ROOT, "t", "running", from + MINUTE, from + 2 * MINUTE), "a1"),
        of(span(ROOT, "t", "permissionPending", from + 2 * MINUTE, from + 3 * MINUTE), "a1"),
        of(span(ROOT, "t", "running", from + 3 * MINUTE, from + 4 * MINUTE), "a1"),
        of(span(ROOT, "t", "completed", from + 4 * MINUTE, from + 4 * MINUTE), "a1"),
        of(span(ROOT, "t", "running", from + 5 * MINUTE, null), "a2"),
        // Ended before the period.
        of(span(ROOT, "t", "running", from - 9 * MINUTE, from - 8 * MINUTE), "old"),
        of(span(ROOT, "t", "stopped", from - 8 * MINUTE, from - 8 * MINUTE), "old"),
      ],
      from,
      now,
    );
    const agents = timeline.lanes[0]?.agents ?? [];
    expect(agents.map((a) => [a.agent.id, a.bars.map((b) => b.phase), a.outcome])).toEqual([
      ["a1", ["running", "attention", "running"], { state: "completed", at: from + 4 * MINUTE }],
      ["a2", ["running"], undefined],
    ]);
    expect(agents[1]?.bars[0]?.end).toBe(now);
  });

  it("finds the tools that failed in the period", () => {
    const tool = (id: string, start: number, end: number | undefined, failed?: boolean) => ({
      id,
      name: "Bash",
      start,
      ...(end !== undefined ? { end } : {}),
      ...(failed ? { failed } : {}),
    });
    expect(
      failedTools(
        [
          tool("ok", from, from + 1),
          tool("bad", from, from + 2, true),
          tool("before", from - 9, from - 5, true),
        ],
        from,
        now,
      ).map(({ at, tool }) => [tool.id, at]),
    ).toEqual([["bad", from + 2]]);
  });

  it("has a lane per session, and an empty one for a worktree with none", () => {
    const timeline = buildTimeline(
      family(worktree(ROOT, ["t", "s"]), worktree(TASK, [])),
      [],
      from,
      now,
    );
    expect(timeline.lanes.map((l) => [l.worktree.workspace.id, l.session?.tabId])).toEqual([
      [ROOT, "t"],
      [ROOT, "s"],
      [TASK, undefined],
    ]);
  });
});

describe("rangeStart and ticksBetween", () => {
  const at = (h: number, m: number) => new Date(2026, 10, 1, h, m, 30).getTime();

  it("starts today at local midnight", () => {
    expect(rangeStart("today", at(14, 7))).toBe(new Date(2026, 10, 1).getTime());
    expect(rangeStart("2h", at(14, 7))).toBe(at(12, 7));
  });

  it("marks round clock times, at most six", () => {
    const clock = (t: number) => {
      const d = new Date(t);
      return `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
    };
    expect(ticksBetween(at(13, 37), at(14, 7)).map(clock)).toEqual([
      "13:40",
      "13:45",
      "13:50",
      "13:55",
      "14:00",
      "14:05",
    ]);
    expect(ticksBetween(at(12, 7), at(14, 7)).map(clock)).toEqual([
      "12:30",
      "13:00",
      "13:30",
      "14:00",
    ]);
    expect(ticksBetween(new Date(2026, 10, 1).getTime(), at(23, 0)).length).toBeLessThanOrEqual(6);
  });
});
