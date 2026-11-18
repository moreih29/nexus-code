/**
 * Another computer's terminal while its Claude Code asks for leave: the
 * request under the screen, in the words and look of this computer's agent
 * list, with the answers terminal.answer takes.
 */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

const { RemoteTerminalAsk, askParts } = await import(
  "../../../../../src/renderer/components/agent-view/remote-terminal-ask"
);

describe("a terminal's Claude Code asking, from another computer", () => {
  test("its line is read as the tool and what it is for", () => {
    expect(askParts("Bash npm test -- --watch")).toEqual({
      tool: "Bash",
      target: "npm test -- --watch",
    });
    expect(askParts("WebSearch")).toEqual({ tool: "WebSearch", target: "" });
  });

  test("shows as the agent list's request: its title, the tool, and the four answers", () => {
    const html = renderToStaticMarkup(
      <RemoteTerminalAsk
        ask={{ requestId: "r1", text: "Bash rm -rf dist" }}
        onAnswer={() => Promise.resolve({ ok: true } as never)}
        onAnswered={() => {}}
      />,
    );
    expect(html).toContain('aria-label="Permission request"');
    expect(html).toContain(">Bash<");
    expect(html).toContain("rm -rf dist");
    for (const answer of ["Allow", "Always allow", "Deny", "Deny and stop"]) {
      expect(html).toContain(`>${answer}</button>`);
    }
    expect(html).toContain("The terminal&#x27;s permission prompt can answer it too.");
    // The agent list's warning frame.
    expect(html).toContain("border-(--state-warning-fg)/40");
  });
});
