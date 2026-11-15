import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

const { Unreachable, contextLineOf, remoteAnswerOf } = await import(
  "../../../../../src/renderer/components/agent-view/remote-pane"
);

describe("controlling another computer's chat", () => {
  test("the card's answers go as the protocol has them", () => {
    expect(remoteAnswerOf({ kind: "allow" })).toEqual({ decision: "allow" });
    expect(remoteAnswerOf({ kind: "allow", updatedInput: { answers: { q: "a" } } })).toEqual({
      decision: "allow",
      updatedInput: { answers: { q: "a" } },
    });
    expect(remoteAnswerOf({ kind: "allow-always", suggestions: [{}] })).toEqual({
      decision: "allow",
    });
    expect(remoteAnswerOf({ kind: "deny", message: "not now" })).toEqual({
      decision: "deny",
      message: "not now",
    });
    expect(remoteAnswerOf({ kind: "deny-stop" })).toEqual({ decision: "deny", stop: true });
  });

  test("the line under the composer tells how full the context is, once the panel says", () => {
    expect(contextLineOf(undefined)).toBeNull();
    const panel = {
      todos: [],
      tasks: [],
      agents: [],
      changedFiles: [],
      context: { usedTokens: 31_500, maxTokens: 1_000_000 },
      goal: null,
    };
    expect(contextLineOf(panel)).toEqual({
      context: { percent: 3, used: 31_500, max: 1_000_000 },
      meters: [],
      more: [],
    });
    expect(contextLineOf({ ...panel, context: null })).toBeNull();
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
