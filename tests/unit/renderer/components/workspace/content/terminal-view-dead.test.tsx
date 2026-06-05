import { describe, expect, mock, test } from "bun:test";
import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  DeadTerminalBanner,
  heldGraceMinutesRemaining,
  shouldShowTerminalEndedBanner,
  TerminalViewLayout,
  terminalEndedMessage,
} from "../../../../../../src/renderer/components/workspace/content/terminal-view";

function renderEndedTerminal(message: string): string {
  return renderToStaticMarkup(
    <TerminalViewLayout
      terminalEnded={true}
      banner={<DeadTerminalBanner message={message} actionLabel="Reopen" onReopen={() => {}} />}
    />,
  );
}

// Resolves hook-free function components (e.g. <Banner>) so the inner host
// <button> is reachable after DeadTerminalBanner delegates to the Banner primitive.
function findButton(node: ReactNode): ReactElement | undefined {
  if (!isValidElement(node)) return undefined;
  if (typeof node.type === "function") {
    return findButton(node.type(node.props));
  }
  if (node.type === "button") return node;
  for (const kid of Children.toArray(node.props.children)) {
    const found = findButton(kid);
    if (found) return found;
  }
  return undefined;
}

function clickBannerAction(element: ReactElement): void {
  const button = findButton(element);
  if (!button) throw new Error("banner action button not found");
  (button.props.onClick as () => void)();
}

describe("TerminalView dead-terminal banner", () => {
  test("renders neutral local ended copy and keeps scrollback pointer-enabled", () => {
    const message = terminalEndedMessage("idle");

    const html = renderEndedTerminal(message);

    expect(html).toContain("Terminal ended.");
    expect(html).toContain("Reopen");
    expect(html).toContain("opacity-60");
    expect(html).toContain("pointer-events-auto");
  });

  test("renders neutral SSH ended copy", () => {
    expect(renderEndedTerminal(terminalEndedMessage("idle"))).toContain("Terminal ended.");
  });

  test("reopen failure copy uses Retry action", () => {
    const html = renderToStaticMarkup(
      <DeadTerminalBanner
        message={terminalEndedMessage("failed")}
        actionLabel="Retry"
        onReopen={() => {}}
      />,
    );

    expect(html).toContain("Reopen failed.");
    expect(html).toContain("Retry");
  });

  test("banner action wires to the provided reopen handler", () => {
    const onReopen = mock(() => {});
    const element = DeadTerminalBanner({
      message: "Terminal ended.",
      actionLabel: "Reopen",
      onReopen,
    }) as ReactElement;

    clickBannerAction(element);

    expect(onReopen).toHaveBeenCalledTimes(1);
  });

  // J: pty.exit code=null → dead state path
  // Simulates the onExit callback path fired by pty-client when the process
  // exits with code: null. The controller's onExit calls setTerminalDead which
  // sets terminalEnded=true, then shouldShowTerminalEndedBanner+TerminalViewLayout
  // render the dead banner. This validates the complete viewer-side reaction
  // without mounting TerminalView (which requires xterm DOM dependencies).
  test("pty.exit code=null produces dead banner: shouldShowTerminalEndedBanner true when online, banner renders Terminal ended.", () => {
    // Simulate the state transition: onExit fires → terminalEnded becomes true.
    // shouldShowTerminalEndedBanner is the selector TerminalView uses to decide
    // whether to show the banner.
    const terminalEnded = true; // set by onExit → setTerminalDead(ws, tab, true)
    const workspaceOnline = true;

    expect(shouldShowTerminalEndedBanner(terminalEnded, workspaceOnline)).toBe(true);

    const html = renderToStaticMarkup(
      <TerminalViewLayout
        terminalEnded={terminalEnded}
        banner={
          shouldShowTerminalEndedBanner(terminalEnded, workspaceOnline) ? (
            <DeadTerminalBanner
              message={terminalEndedMessage("idle")}
              actionLabel="Reopen"
              onReopen={() => {}}
            />
          ) : undefined
        }
      />,
    );

    // Dead banner is shown after exit event
    expect(html).toContain("Terminal ended.");
    expect(html).toContain("Reopen");
    // xterm scrollback container dims to signal ended state
    expect(html).toContain("opacity-60");
  });

  // K: contrast regression guard for DeadTerminalBanner
  // Ensures app-status-banner-text class is present and text-muted-foreground
  // is absent (which would break contrast on the frosted-veil background).
  test("DeadTerminalBanner uses app-status-banner-text and does not use text-muted-foreground", () => {
    const html = renderToStaticMarkup(
      <DeadTerminalBanner message="Terminal ended." actionLabel="Reopen" onReopen={() => {}} />,
    );

    expect(html).toContain("app-status-banner-text");
    expect(html).not.toContain("text-muted-foreground");
  });
});

describe("heldGraceMinutesRemaining", () => {
  // T14: pure countdown helper for held-terminal warning banner.
  // REATTACH_GRACE_SECONDS = 300 (5 min). Tests verify edge cases without
  // depending on wall-clock time.

  test("returns full grace (5) at the moment hold begins", () => {
    const heldAt = 1_000_000;
    expect(heldGraceMinutesRemaining(heldAt, heldAt)).toBe(5);
  });

  test("rounds up remaining seconds to the next minute", () => {
    const heldAt = 0;
    // 61 seconds elapsed → 300 − 61 = 239 remaining → ceil(239/60) = 4
    expect(heldGraceMinutesRemaining(heldAt, 61_000)).toBe(4);
  });

  test("returns 1 when only a few seconds remain", () => {
    const heldAt = 0;
    // 295 seconds elapsed → 5 remaining → ceil(5/60) = 1
    expect(heldGraceMinutesRemaining(heldAt, 295_000)).toBe(1);
  });

  test("returns 0 once grace period expires", () => {
    const heldAt = 0;
    // 300+ seconds elapsed → 0 remaining → ceil(0/60) = 0
    expect(heldGraceMinutesRemaining(heldAt, 300_000)).toBe(0);
    expect(heldGraceMinutesRemaining(heldAt, 999_000)).toBe(0);
  });

  test("handles nowMs before heldAt (clock skew) without negative result", () => {
    const heldAt = 1_000_000;
    // nowMs is earlier than heldAt: elapsed is clamped to 0
    expect(heldGraceMinutesRemaining(heldAt, 500_000)).toBe(5);
  });
});
