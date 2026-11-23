import { describe, expect, test } from "bun:test";
import { isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ChatStatus } from "../../../../../packages/remote-protocol/src/view";
import type { BannerProps } from "../../../../../src/renderer/components/ui/banner";
import { useChatStore } from "../../../../../src/renderer/services/chat/store";

const { ChatPhaseBanner, ChatSignedOutBanner } = await import(
  "../../../../../src/renderer/components/chat/chat-state-banner"
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
      <ChatPhaseBanner
        scope={["remote", "tab"]}
        status={status({
          phase: "ended",
          process: "exited",
          exit: { code: 1, stderrTail: "boom" },
        })}
        onRestart={() => {}}
      />,
    );
    expect(html).toContain("Details");
    expect(html).toContain("Restart");
  });

  test("one that only says it exited (before 0.13.0): ended, with nothing to do", () => {
    const html = renderToStaticMarkup(
      <ChatPhaseBanner scope={["remote", "tab"]} status={status({ process: "exited" })} />,
    );
    expect(html).not.toBe("");
    expect(html).toContain('aria-label="Dismiss"');
    expect(html).not.toContain(">Restart<");
  });

  test("a program too old, with its version and trying again", () => {
    const html = renderToStaticMarkup(
      <ChatPhaseBanner
        scope={["remote", "tab"]}
        status={status({ phase: "failed", error: "old-version", version: "1.0.1" })}
        onRestart={() => {}}
      />,
    );
    expect(html).toContain("1.0.1");
    expect(html).toContain("<button");
  });

  test("none while it is ready", () => {
    expect(
      renderToStaticMarkup(
        <ChatPhaseBanner scope={["remote", "tab"]} status={status({ phase: "ready" })} />,
      ),
    ).toBe("");
  });

  test("a subsequent start failure shows again with the same error text", () => {
    const key = "phase-banner-test";
    const scope = ["remote", key];
    const store = useChatStore.getState();
    const starting = () => store.update(key, (prev) => ({ ...prev, phase: "starting" }));
    const failure = () =>
      store.update(key, (prev) => ({ ...prev, phase: "failed", error: "same error" }));
    const current = () =>
      status({
        phase: "failed",
        error: "same error",
        phaseRevision: useChatStore.getState().tabs[key]?.phaseRevision,
      });
    let click: (() => void) | undefined;
    function FirstFailure() {
      const banner = ChatPhaseBanner({ scope, status: current() });
      if (isValidElement<BannerProps>(banner)) click = banner.props.dismiss?.onDismiss;
      return banner;
    }
    try {
      starting();
      failure();
      expect(renderToStaticMarkup(<FirstFailure />)).toContain('aria-label="Dismiss"');
      expect(click).toBeDefined();
      click?.();
      expect(renderToStaticMarkup(<ChatPhaseBanner scope={scope} status={current()} />)).toBe("");
      starting();
      failure();
      expect(renderToStaticMarkup(<ChatPhaseBanner scope={scope} status={current()} />)).toContain(
        'aria-label="Dismiss"',
      );
    } finally {
      store.remove(key);
    }
  });
});

describe("another computer's Codex chat signed out", () => {
  const codex = (more: Partial<ChatStatus>) => status({ agent: "codex", ...more });

  test("shows as a Codex tab here does, with signing in there and checking again", () => {
    const html = renderToStaticMarkup(
      <ChatSignedOutBanner
        scope={["remote", "tab"]}
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
      <ChatSignedOutBanner
        scope={["remote", "tab"]}
        status={codex({ signedOut: true })}
        onCheck={() => {}}
      />,
    );
    expect(html).not.toContain(">Sign in in a terminal<");
    expect(html).toContain(">Check again<");
    expect(
      renderToStaticMarkup(
        <ChatSignedOutBanner scope={["remote", "tab"]} status={codex({ signedOut: true })} />,
      ),
    ).toContain('aria-label="Dismiss"');
  });

  test("none while it is signed in, or its program does not run", () => {
    expect(
      renderToStaticMarkup(<ChatSignedOutBanner scope={["remote", "tab"]} status={codex({})} />),
    ).toBe("");
    expect(
      renderToStaticMarkup(
        <ChatSignedOutBanner
          scope={["remote", "tab"]}
          status={codex({ signedOut: true, process: "exited" })}
        />,
      ),
    ).toBe("");
  });
});
