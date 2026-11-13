import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

const { RemoteComposer, remoteAnswerOf } = await import(
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

  test("the composer offers the stop only while a turn runs", () => {
    const render = (running: boolean) =>
      renderToStaticMarkup(
        <RemoteComposer running={running} onSend={async () => true} onStop={() => {}} />,
      );
    expect(render(true)).toContain('aria-label="Stop"');
    expect(render(false)).not.toContain('aria-label="Stop"');
    expect(render(false)).toContain('placeholder="Write to it from here"');
  });
});
