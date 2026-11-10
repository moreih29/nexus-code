/**
 * A conversation's goal (/goal) as the tab reads it: Claude Code's stream
 * and transcript, and Codex's thread goal. The lines are as Claude Code
 * 2.1.319 and codex app-server 0.167.0 wrote them.
 */
import { describe, expect, test } from "bun:test";
import {
  applyCodexLines,
  type CodexModel,
  emptyCodexModel,
} from "../../../../../src/renderer/services/chat/codex-model";
import {
  clockLabel,
  firstLineOf,
  goalFeedbackReason,
  goalSeconds,
  goalViewOf,
} from "../../../../../src/renderer/services/chat/goal";
import { historyModel, transcriptGoal } from "../../../../../src/renderer/services/chat/history";
import {
  applyLines,
  type ChatLine,
  type ChatModel,
  emptyModel,
  endGoal,
} from "../../../../../src/renderer/services/chat/model";

const GOAL = "npm test passes";
const SET_AT = Date.parse("2026-11-10T13:52:27.989Z");

let seq = 0;
const out = (message: unknown, at = 1000): ChatLine => ({ seq: ++seq, dir: "out", message, at });

/** /goal's output, a message Claude Code writes itself. */
function goalOutput(text: string, args = GOAL): ChatLine {
  return out({
    type: "assistant",
    message: {
      model: "<synthetic>",
      id: `syn-${seq}`,
      role: "assistant",
      content: [{ type: "text", text }],
    },
    parent_tool_use_id: null,
    local_command_source: `<local-command-stdout>${text}</local-command-stdout>`,
    uuid: `g-${seq}`,
    timestamp: "2026-11-10T13:52:27.989Z",
    local_command_run: { command: "goal", args },
  });
}

/** A check that found the goal unmet, which Claude reads to go on. */
function feedback(reason: string, condition = GOAL): ChatLine {
  return out({
    type: "user",
    message: {
      role: "user",
      content: [{ type: "text", text: `Stop hook feedback:\n[${condition}]: ${reason}` }],
    },
    parent_tool_use_id: null,
    uuid: `f-${seq}`,
    timestamp: "2026-11-10T13:52:40.504Z",
    isSynthetic: true,
  });
}

function said(text: string): ChatLine {
  return out({
    type: "assistant",
    message: { id: `m-${seq}`, role: "assistant", content: [{ type: "text", text }] },
    parent_tool_use_id: null,
    uuid: `a-${seq}`,
  });
}

function shown(model: ChatModel): string[] {
  return model.items.map((item) =>
    item.kind === "notice"
      ? `notice:${item.code}`
      : item.kind === "user"
        ? `user:${item.text}`
        : `assistant:${item.blocks.map((b) => (b.type === "text" ? b.text : b.type)).join("")}`,
  );
}

describe("a Claude goal in the stream", () => {
  test("is set by /goal's output, which shows as a notice", () => {
    const model = applyLines(emptyModel(), [goalOutput(`Goal set: ${GOAL}`)]);
    expect(model.goal).toMatchObject({ condition: GOAL, status: "active", checks: [] });
    expect(model.goal?.setAt).toBe(SET_AT);
    expect(shown(model)).toEqual(["notice:goal_set"]);
  });

  test("takes the condition as typed when the output cuts it short", () => {
    const long = "x".repeat(300);
    const model = applyLines(emptyModel(), [goalOutput(`Goal set: ${"x".repeat(80)}…`, long)]);
    expect(model.goal?.condition).toBe(long);
  });

  test("counts each check that found it unmet, which is no message of the user's", () => {
    const model = applyLines(emptyModel(), [
      goalOutput(`Goal set: ${GOAL}`),
      said("working"),
      feedback("3 tests still fail"),
      said("fixed two"),
      feedback("1 test still fails"),
    ]);
    expect(model.goal?.checks.map((c) => c.reason)).toEqual([
      "3 tests still fail",
      "1 test still fails",
    ]);
    expect(shown(model)).toEqual(["notice:goal_set", "assistant:working", "assistant:fixed two"]);
  });

  test("a feedback taken back as a message does not take one the user sent", () => {
    // With --replay-user-messages a message the CLI took comes back as a replay.
    const set = goalOutput(`Goal set: ${GOAL}`);
    const sent: ChatLine = {
      seq: ++seq,
      dir: "in",
      message: {
        type: "user",
        uuid: "mine",
        message: { role: "user", content: [{ type: "text", text: "hi" }] },
      },
    };
    const replayed = feedback("not yet");
    (replayed.message as Record<string, unknown>).isReplay = true;
    const model = applyLines(emptyModel(), [set, sent, replayed]);
    expect(model.goal?.checks).toHaveLength(1);
    expect(model.items.find((i) => i.kind === "user")).toMatchObject({ text: "hi", state: "sent" });
  });

  test("another Stop hook's feedback is not the goal's", () => {
    const model = applyLines(emptyModel(), [
      goalOutput(`Goal set: ${GOAL}`),
      feedback("lint first", "./check.sh"),
    ]);
    expect(model.goal?.checks).toEqual([]);
    expect(shown(model)).toEqual(["notice:goal_set"]);
  });

  test("is cleared by /goal clear, and /clear forgets it", () => {
    const cleared = applyLines(emptyModel(), [
      goalOutput(`Goal set: ${GOAL}`),
      goalOutput(`Goal cleared: ${GOAL}`, "clear"),
    ]);
    expect(cleared.goal).toBeNull();
    expect(shown(cleared)).toEqual(["notice:goal_set", "notice:goal_cleared"]);
    const reset = applyLines(emptyModel(), [
      goalOutput(`Goal set: ${GOAL}`),
      out({ type: "conversation_reset" }),
    ]);
    expect(reset.goal).toBeUndefined();
  });

  test("/goal's other answers show as they are", () => {
    const model = applyLines(emptyModel(), [goalOutput(`Goal active: ${GOAL} (3m)`, "")]);
    expect(model.goal).toBeUndefined();
    expect(shown(model)).toEqual([`assistant:Goal active: ${GOAL} (3m)`]);
  });
});

/** A transcript's entries for a goal checked twice and met. */
const TRANSCRIPT = [
  {
    type: "attachment",
    timestamp: "2026-11-10T13:52:27.988Z",
    attachment: { type: "goal_status", met: false, sentinel: true, condition: GOAL },
  },
  {
    type: "user",
    uuid: "u1",
    timestamp: "2026-11-10T13:52:27.980Z",
    message: {
      role: "user",
      content: `<command-name>/goal</command-name>\n<command-message>goal</command-message>\n<command-args>${GOAL}</command-args>`,
    },
  },
  {
    type: "system",
    subtype: "local_command",
    uuid: "s1",
    timestamp: "2026-11-10T13:52:27.989Z",
    content: `<local-command-stdout>Goal set: ${GOAL}</local-command-stdout>`,
  },
  {
    type: "user",
    uuid: "u2",
    isMeta: true,
    message: {
      role: "user",
      content: `A session-scoped Stop hook is now active with condition: "${GOAL}"`,
    },
  },
  {
    type: "assistant",
    uuid: "a1",
    timestamp: "2026-11-10T13:52:35.000Z",
    message: { id: "m1", role: "assistant", content: [{ type: "text", text: "fixing" }] },
  },
  {
    type: "attachment",
    timestamp: "2026-11-10T13:52:40.505Z",
    attachment: { type: "goal_status", met: false, condition: GOAL, reason: "2 tests fail" },
  },
  {
    type: "user",
    uuid: "u3",
    isMeta: true,
    message: { role: "user", content: `Stop hook feedback:\n[${GOAL}]: 2 tests fail` },
  },
  {
    type: "assistant",
    uuid: "a2",
    timestamp: "2026-11-10T13:52:50.000Z",
    message: { id: "m2", role: "assistant", content: [{ type: "text", text: "done" }] },
  },
  {
    type: "attachment",
    timestamp: "2026-11-10T13:52:53.172Z",
    attachment: {
      type: "goal_status",
      met: true,
      condition: GOAL,
      reason: "all tests pass",
      iterations: 2,
      durationMs: 25183,
      tokens: 1761,
    },
  },
];

describe("a Claude goal in the transcript", () => {
  test("shows where it was set and met, between the messages", () => {
    const model = historyModel(TRANSCRIPT);
    expect(shown(model)).toEqual([
      `user:/goal ${GOAL}`,
      "notice:goal_set",
      "assistant:fixing",
      "assistant:done",
      "notice:goal_met",
    ]);
  });

  test("tells how it ended: its checks, how long and how many tokens", () => {
    const goal = transcriptGoal(TRANSCRIPT);
    expect(goal).toMatchObject({
      condition: GOAL,
      status: "met",
      reason: "all tests pass",
      iterations: 2,
      durationMs: 25183,
      tokens: 1761,
      setAt: SET_AT,
    });
    expect(goal?.checks.map((c) => c.reason)).toEqual(["2 tests fail"]);
  });

  test("one found impossible fails", () => {
    const failed = [
      ...TRANSCRIPT.slice(0, 3),
      {
        type: "attachment",
        timestamp: "2026-11-10T13:53:00.000Z",
        attachment: {
          type: "goal_status",
          met: false,
          failed: true,
          condition: GOAL,
          reason: "no network",
        },
      },
    ];
    expect(transcriptGoal(failed)).toMatchObject({ status: "failed", reason: "no network" });
    expect(shown(historyModel(failed)).at(-1)).toBe("notice:goal_failed");
  });
});

describe("endGoal", () => {
  test("ends the running goal as the transcript told, its notice after what came before", () => {
    const at = (iso: string) => Date.parse(iso);
    const live = applyLines(emptyModel(), [
      goalOutput(`Goal set: ${GOAL}`),
      out(
        {
          type: "assistant",
          message: { id: "m1", content: [{ type: "text", text: "done" }] },
          parent_tool_use_id: null,
        },
        at("2026-11-10T13:52:50.000Z"),
      ),
      out(
        {
          type: "assistant",
          message: { id: "m2", content: [{ type: "text", text: "later" }] },
          parent_tool_use_id: null,
        },
        at("2026-11-10T13:53:30.000Z"),
      ),
    ]);
    const told = transcriptGoal(TRANSCRIPT);
    if (!told) throw new Error("no goal told");
    const ended = endGoal(live, told);
    expect(ended.goal).toMatchObject({ status: "met", endedLive: true, durationMs: 25183 });
    expect(shown(ended)).toEqual([
      "notice:goal_set",
      "assistant:done",
      "notice:goal_met",
      "assistant:later",
    ]);
    expect(goalViewOf(ended)?.ended).toBe(true);
  });

  test("leaves another goal, or one that is still running, as it is", () => {
    const live = applyLines(emptyModel(), [goalOutput("Goal set: other", "other")]);
    const told = transcriptGoal(TRANSCRIPT);
    if (!told) throw new Error("no goal told");
    expect(endGoal(live, told)).toBe(live);
    expect(endGoal(live, { ...told, condition: "other", status: "active" })).toBe(live);
  });

  test("a goal that ended before the tab looked on is not shown", () => {
    expect(goalViewOf(historyModel(TRANSCRIPT))).toBeNull();
  });
});

describe("a Codex goal", () => {
  const T = "thr_1";
  let n = 0;
  const line = (dir: "in" | "out", message: unknown, at = 5_000): ChatLine => ({
    seq: ++n,
    dir,
    message,
    at,
  });
  const goal = (status: string, extra: Record<string, unknown> = {}) => ({
    threadId: T,
    objective: "migrate the form",
    status,
    timeUsedSeconds: 120,
    tokensUsed: 4_000,
    tokenBudget: 10_000,
    createdAt: 1_700_000_000,
    updatedAt: 1_700_000_100,
    ...extra,
  });
  function started(): ChatLine[] {
    return [
      line("in", { id: "s", method: "thread/resume", params: { threadId: T } }),
      line("out", { id: "s", result: { thread: { id: T, turns: [] } } }),
    ];
  }
  const run = (lines: ChatLine[]): CodexModel => applyCodexLines(emptyCodexModel(), lines, 5_000);

  test("is read when the thread is resumed, and follows its updates", () => {
    const model = run([
      ...started(),
      line("in", { id: "g", method: "thread/goal/get", params: { threadId: T } }),
      line("out", { id: "g", result: { goal: goal("active") } }),
      line("out", {
        method: "thread/goal/updated",
        params: { threadId: T, goal: goal("budgetLimited", { tokensUsed: 10_000 }) },
      }),
    ]);
    expect(model.threadGoal).toMatchObject({
      objective: "migrate the form",
      status: "budgetLimited",
      tokensUsed: 10_000,
      tokenBudget: 10_000,
      createdAt: 1_700_000_000_000,
      usedAt: 5_000,
    });
    expect(goalViewOf(model)?.status).toBe("budgetLimited");
  });

  test("completing as the tab looks on is shown; complete when resumed is not", () => {
    const live = run([
      ...started(),
      line("out", { method: "thread/goal/updated", params: { threadId: T, goal: goal("active") } }),
      line("out", {
        method: "thread/goal/updated",
        params: { threadId: T, goal: goal("complete") },
      }),
    ]);
    expect(goalViewOf(live)).toMatchObject({ status: "met", ended: true, endedLive: true });
    const resumed = run([
      ...started(),
      line("in", { id: "g", method: "thread/goal/get", params: { threadId: T } }),
      line("out", { id: "g", result: { goal: goal("complete") } }),
    ]);
    expect(resumed.threadGoal?.status).toBe("complete");
    expect(goalViewOf(resumed)).toBeNull();
  });

  test("is cleared, and another thread's goal is not the tab's", () => {
    const model = run([
      ...started(),
      line("out", { method: "thread/goal/updated", params: { threadId: T, goal: goal("active") } }),
      line("out", {
        method: "thread/goal/updated",
        params: { threadId: "thr_sub", goal: goal("paused", { threadId: "thr_sub" }) },
      }),
    ]);
    expect(model.threadGoal?.status).toBe("active");
    const cleared = applyCodexLines(model, [
      line("out", { method: "thread/goal/cleared", params: { threadId: T } }),
    ]);
    expect(cleared.threadGoal).toBeNull();
  });

  test("a failed read says nothing in the conversation", () => {
    const model = run([
      ...started(),
      line("in", { id: "g", method: "thread/goal/get", params: { threadId: T } }),
      line("out", { id: "g", error: { code: -32601, message: "goals are off" } }),
    ]);
    expect(model.items).toEqual([]);
  });
});

describe("goal helpers", () => {
  test("goalFeedbackReason reads the goal's reason, not another hook's", () => {
    const text = `Stop hook feedback:\n[${GOAL}]: still failing`;
    expect(goalFeedbackReason(text, GOAL)).toBe("still failing");
    expect(goalFeedbackReason(text, "other")).toBeNull();
    expect(goalFeedbackReason("hello", GOAL)).toBeNull();
  });

  test("clockLabel and firstLineOf", () => {
    expect(clockLabel(4)).toBe("0:04");
    expect(clockLabel(724)).toBe("12:04");
    expect(clockLabel(4324)).toBe("1:12:04");
    expect(firstLineOf("do this:\n- a\n- b")).toEqual({ line: "do this:", more: 2 });
    expect(firstLineOf("one line")).toEqual({ line: "one line", more: 0 });
  });

  test("goalSeconds: Claude's since it was set, Codex's worked time counting on in a turn", () => {
    const claude = goalViewOf(applyLines(emptyModel(), [goalOutput(`Goal set: ${GOAL}`)]));
    if (!claude) throw new Error("no goal");
    expect(goalSeconds(claude, SET_AT + 90_000)).toBe(90);
    const codex = goalViewOf({
      threadGoal: {
        objective: "o",
        status: "active",
        timeUsedSeconds: 100,
        usedAt: 10_000,
        tokensUsed: 0,
        tokenBudget: null,
      },
    });
    if (!codex) throw new Error("no goal");
    expect(goalSeconds(codex, 70_000, { running: false })).toBe(100);
    expect(goalSeconds(codex, 70_000, { running: true, startedAt: 40_000 })).toBe(130);
  });
});
