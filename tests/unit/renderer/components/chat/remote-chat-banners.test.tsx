import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ChatPage } from "../../../../../packages/remote-protocol/src";
import { modelOfPage } from "../../../../../src/renderer/services/remote/chat-model";

const { TerminalTwinBanner } = await import(
  "../../../../../src/renderer/components/chat/terminal-twin-banner"
);
const { TurnFailureBanner } = await import(
  "../../../../../src/renderer/components/chat/turn-failure-banner"
);

const page = (status: Partial<ChatPage["status"]>): ChatPage => ({
  status: {
    agent: "claude",
    title: "t",
    running: false,
    process: "running",
    turn: null,
    streaming: null,
    permissions: [],
    ...status,
  },
  start: 0,
  total: 0,
  items: [],
  tools: {},
  tasks: {},
  agentItems: {},
});

const retry = async () => {};

describe("another computer's chat's turn failure", () => {
  test("a temporary error offers to try again, as this app's chat does", () => {
    const model = modelOfPage(page({ failure: { kind: "transient", status: 529, at: 1 } }));
    const html = renderToStaticMarkup(
      <TurnFailureBanner scope={["remote", "a"]} model={model} onRetry={retry} />,
    );
    expect(html).toContain("chat-turn-failure");
    expect(html).toContain("Try again");
  });

  test("a sign-in failure says so, with nothing to try again", () => {
    const model = modelOfPage(page({ failure: { kind: "auth", status: 401 } }));
    const html = renderToStaticMarkup(
      <TurnFailureBanner scope={["remote", "b"]} model={model} onRetry={retry} />,
    );
    expect(html).toContain("401");
    expect(html).not.toContain("Try again");
  });

  test("none while a turn runs, for the usage limit, or from a host before 0.32.0", () => {
    const shown = (status: Partial<ChatPage["status"]>) =>
      renderToStaticMarkup(
        <TurnFailureBanner
          scope={["remote", "c"]}
          model={modelOfPage(page(status))}
          onRetry={retry}
        />,
      );
    expect(shown({ running: true, failure: { kind: "transient" } })).toBe("");
    expect(shown({ failure: { kind: "usage_limit" } })).toBe("");
    expect(shown({ failure: { kind: "other" } })).toBe("");
    expect(shown({})).toBe("");
  });
});

describe("another computer's chat run in a terminal too", () => {
  test("says so, and shows the terminal where it can", () => {
    const html = renderToStaticMarkup(
      <TerminalTwinBanner scope={["remote", "d"]} twin="t1" onShow={() => {}} />,
    );
    expect(html).toContain("chat-terminal-twin");
    expect(html).toContain("Show the terminal");
  });

  test("says so without the button where the terminal cannot be opened", () => {
    const html = renderToStaticMarkup(<TerminalTwinBanner scope={["remote", "e"]} twin="t1" />);
    expect(html).toContain("chat-terminal-twin");
    expect(html).not.toContain("Show the terminal");
  });

  test("none without a twin", () => {
    expect(renderToStaticMarkup(<TerminalTwinBanner scope={["remote", "f"]} twin={null} />)).toBe(
      "",
    );
    expect(
      renderToStaticMarkup(<TerminalTwinBanner scope={["remote", "g"]} twin={undefined} />),
    ).toBe("");
  });
});
