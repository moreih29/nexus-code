import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ChatStatus } from "../../../../../packages/remote-protocol/src/view";

const { RemotePhaseBanner, RemoteSignedOutBanner } = await import(
  "../../../../../src/renderer/components/agent-view/remote-phase-banner"
);

const status = (more: Partial<ChatStatus>): ChatStatus => ({
  agent: "claude",
  title: "t",
  running: false,
  process: "running",
  turn: null,
  streaming: null,
  permissions: [],
  ...more,
});

describe("another computer's chat's banner", () => {
  test("an ended program, with what it wrote and starting it again", () => {
    const html = renderToStaticMarkup(
      <RemotePhaseBanner
        status={status({
          phase: "ended",
          process: "exited",
          exit: { code: 1, stderrTail: "boom" },
        })}
        onRestart={() => {}}
      />,
    );
    // What it wrote, folded under its details as a chat here has them.
    expect(html).toContain("Details");
    expect(html).toContain("Restart");
  });

  test("one that only says it exited (before 0.13.0): ended, with nothing to do", () => {
    const html = renderToStaticMarkup(<RemotePhaseBanner status={status({ process: "exited" })} />);
    expect(html).not.toBe("");
    expect(html).not.toContain("<button");
  });

  test("a program too old, with its version and trying again", () => {
    const html = renderToStaticMarkup(
      <RemotePhaseBanner
        status={status({ phase: "failed", error: "old-version", version: "1.0.1" })}
        onRestart={() => {}}
      />,
    );
    expect(html).toContain("1.0.1");
    expect(html).toContain("<button");
  });

  test("none while it is ready", () => {
    expect(renderToStaticMarkup(<RemotePhaseBanner status={status({ phase: "ready" })} />)).toBe(
      "",
    );
  });
});

describe("another computer's Codex chat signed out", () => {
  const codex = (more: Partial<ChatStatus>) => status({ agent: "codex", ...more });

  test("shows as a Codex tab here does, with signing in there and checking again", () => {
    const html = renderToStaticMarkup(
      <RemoteSignedOutBanner
        status={codex({ signedOut: true })}
        onSignIn={() => {}}
        onCheck={() => {}}
      />,
    );
    expect(html).toContain("Codex is not signed in");
    expect(html).toContain(">Sign in in a terminal<");
    expect(html).toContain(">Check again<");
  });

  test("without what this device may not do there", () => {
    const html = renderToStaticMarkup(
      <RemoteSignedOutBanner status={codex({ signedOut: true })} onCheck={() => {}} />,
    );
    expect(html).not.toContain(">Sign in in a terminal<");
    expect(html).toContain(">Check again<");
    expect(
      renderToStaticMarkup(<RemoteSignedOutBanner status={codex({ signedOut: true })} />),
    ).not.toContain("<button");
  });

  test("none while it is signed in, or its program does not run", () => {
    expect(renderToStaticMarkup(<RemoteSignedOutBanner status={codex({})} />)).toBe("");
    expect(
      renderToStaticMarkup(
        <RemoteSignedOutBanner status={codex({ signedOut: true, process: "exited" })} />,
      ),
    ).toBe("");
  });
});
