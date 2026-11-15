import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

const { usageLineOf } = await import(
  "../../../../../src/renderer/components/agent-view/remote-usage"
);
const { Unreachable, remoteAnswerOf } = await import(
  "../../../../../src/renderer/components/agent-view/remote-pane"
);

describe("controlling another computer's chat", () => {
  test("the card's answers go as the protocol has them", () => {
    const request = {
      requestId: "r",
      toolName: "Bash",
      input: {},
      suggestions: [
        { type: "remote", label: "Bash(npm test:*)", index: 0 },
        { type: "remote", label: "Accept edits", index: 1 },
      ],
    };
    expect(remoteAnswerOf({ kind: "allow" }, request)).toEqual({ decision: "allow" });
    expect(
      remoteAnswerOf({ kind: "allow", updatedInput: { answers: { q: "a" } } }, request),
    ).toEqual({
      decision: "allow",
      updatedInput: { answers: { q: "a" } },
    });
    expect(remoteAnswerOf({ kind: "deny", message: "not now" }, request)).toEqual({
      decision: "deny",
      message: "not now",
    });
    expect(remoteAnswerOf({ kind: "deny-stop" }, request)).toEqual({
      decision: "deny",
      stop: true,
    });
  });

  test("an always-allow keeps the suggestions it picked by their index there, or all of them", () => {
    const request = {
      requestId: "r",
      toolName: "Bash",
      input: {},
      suggestions: [
        { type: "remote", label: "Bash(npm test:*)", index: 0 },
        { type: "remote", label: "Accept edits", index: 1 },
      ],
    };
    expect(remoteAnswerOf({ kind: "allow-always" }, request)).toEqual({
      decision: "allow",
      always: [0, 1],
    });
    expect(
      remoteAnswerOf({ kind: "allow-always", suggestions: [request.suggestions[1]] }, request),
    ).toEqual({ decision: "allow", always: [1] });
    // A request with none to keep is allowed once.
    expect(remoteAnswerOf({ kind: "allow-always" }, { ...request, suggestions: [] })).toEqual({
      decision: "allow",
    });
  });

  test("the line under the composer tells how full the context is, once the panel says", () => {
    expect(usageLineOf(undefined)).toBeNull();
    const panel = {
      todos: [],
      tasks: [],
      agents: [],
      changedFiles: [],
      context: { usedTokens: 31_500, maxTokens: 1_000_000 },
      goal: null,
    };
    expect(usageLineOf(panel)).toEqual({
      context: { percent: 3, used: 31_500, max: 1_000_000 },
      meters: [],
      more: [],
    });
    expect(usageLineOf({ ...panel, context: null })).toBeNull();
  });

  test("and the plan's usage the device tells, but a window started over since or of a kind unknown", () => {
    const panel = {
      todos: [],
      tasks: [],
      agents: [],
      changedFiles: [],
      context: null,
      goal: null,
      planLimits: [
        { kind: "session", percent: 16, resetsAt: 2_000 },
        { kind: "weekly", percent: 61, resetsAt: 9_000 },
        { kind: "weekly_scoped", scope: "Fable", percent: 0, resetsAt: 9_000 },
        { kind: "monthly", percent: 5 },
      ],
    };
    expect(usageLineOf(panel, 1_000)).toEqual({
      meters: [
        { kind: "session", percent: 16, resetsAt: 2_000 },
        { kind: "weekly", percent: 61, resetsAt: 9_000 },
      ],
      more: [{ kind: "weekly_scoped", scope: "Fable", percent: 0, resetsAt: 9_000 }],
    });
    // The session's window started over: its old percent is no longer so.
    expect(usageLineOf(panel, 3_000)?.meters.map((m) => m.kind)).toEqual(["weekly"]);
    expect(
      usageLineOf({ ...panel, planLimits: [{ kind: "session", percent: 9, resetsAt: 1 }] }, 3_000),
    ).toBeNull();
  });

  test("a session out of reach says why, in place of the controls", () => {
    const offline = renderToStaticMarkup(<Unreachable reach="offline" device="Work PC" />);
    expect(offline).toContain('role="status"');
    expect(offline).toContain("Work PC is offline. Showing what it last sent.");
    const disconnected = renderToStaticMarkup(
      <Unreachable reach="disconnected" device="Work PC" />,
    );
    expect(disconnected).toContain("Not connected to the server.");
  });
});
