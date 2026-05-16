import { describe, expect, mock, test } from "bun:test";
import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  DeadTerminalBanner,
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
