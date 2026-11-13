import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

const { RemoteComposer, Unreachable, remoteAnswerOf } = await import(
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

  test("the composer offers the stop while a turn runs, and the send when there is text", () => {
    const render = (running: boolean) =>
      renderToStaticMarkup(
        <RemoteComposer
          device="Work PC"
          running={running}
          onSend={async () => true}
          onStop={() => {}}
        />,
      );
    expect(render(true)).toContain('aria-label="Stop"');
    // An empty box during a turn offers only the stop, as this app's own composer does.
    expect(render(true)).not.toContain('aria-label="Send"');
    expect(render(false)).not.toContain('aria-label="Stop"');
    expect(render(false)).toContain('aria-label="Send"');
    expect(render(false)).toContain('placeholder="Message Work PC"');
  });

  test("a session out of reach says why, in place of the controls", () => {
    const offline = renderToStaticMarkup(<Unreachable reach="offline" device="Work PC" />);
    expect(offline).toContain('role="status"');
    expect(offline).toContain("Work PC is offline. This is how the session last looked.");
    const disconnected = renderToStaticMarkup(
      <Unreachable reach="disconnected" device="Work PC" />,
    );
    expect(disconnected).toContain("Not connected to the server.");
  });
});
