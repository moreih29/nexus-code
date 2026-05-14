import { describe, expect, mock, test } from "bun:test";
import { Children, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  DeadTerminalBanner,
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

function clickBannerAction(element: ReactElement): void {
  const children = Children.toArray(element.props.children) as ReactElement[];
  const button = children.find((child) => child.type === "button");
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
});
