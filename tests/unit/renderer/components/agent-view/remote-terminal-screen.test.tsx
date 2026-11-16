/**
 * Another computer's terminal drawn as this one's: its runs' colors from the
 * theme's terminal palette, and the end kept in sight.
 */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  lookOf,
  RemoteTerminalScreen,
} from "../../../../../src/renderer/components/agent-view/remote-terminal-screen";

const sixteen = Array.from({ length: 16 }, (_, i) => `#0000${i.toString(16).padStart(2, "0")}`);
const colors = { sixteen, foreground: "#eeeeee", background: "var(--surface-island-bg)" };

describe("a run's look", () => {
  test("is none in the default style", () => {
    expect(lookOf({}, colors)).toBeUndefined();
  });

  test("draws bold in the first eight colors in their bright ones, as xterm does", () => {
    expect(lookOf({ fg: 1, bold: true }, colors)).toEqual({ color: "#000009", fontWeight: 700 });
    expect(lookOf({ fg: 9, bold: true }, colors)?.color).toBe("#000009");
    expect(lookOf({ fg: 1 }, colors)?.color).toBe("#000001");
  });

  test("swaps inverse colors, the island's surface for a default background", () => {
    expect(lookOf({ inverse: true }, colors)).toEqual({
      color: "var(--surface-island-bg)",
      backgroundColor: "#eeeeee",
    });
  });

  test("dims at half strength, hides, and draws its lines", () => {
    expect(lookOf({ dim: true }, colors)?.color).toBe(
      "color-mix(in srgb, #eeeeee 50%, transparent)",
    );
    expect(lookOf({ hidden: true, fg: 2 }, colors)?.color).toBe("transparent");
    expect(lookOf({ underline: true, strike: true, italic: true }, colors)).toEqual({
      fontStyle: "italic",
      textDecorationLine: "underline line-through",
    });
    expect(lookOf({ fg: "#123456", bg: 200 }, colors)).toEqual({
      color: "#123456",
      backgroundColor: "#ff00d7",
    });
  });
});

describe("the screen", () => {
  test("draws the text in its colors, a line each, without the blank end", () => {
    const html = renderToStaticMarkup(
      <RemoteTerminalScreen text={"\x1b[1;32mok\x1b[0m done\nnext\n\n   \n"} />,
    );
    expect(html).toContain('data-testid="remote-terminal"');
    expect(html).toContain("font-weight:700");
    expect(html).toContain(">ok</span> done\nnext</pre>");
    expect(html).not.toContain("\x1b");
  });

  test("goes on in the next line where the pane is narrower, as a terminal does", () => {
    const html = renderToStaticMarkup(<RemoteTerminalScreen text="a long line" />);
    expect(html).toContain("whitespace-pre-wrap");
    expect(html).toContain("break-all");
  });

  test("takes the keyboard only where the computer lets this one type", () => {
    const looking = renderToStaticMarkup(<RemoteTerminalScreen text="$ ls" />);
    expect(looking).not.toContain("remote-terminal-input");
    expect(looking).not.toContain("cursor-text");
    const typing = renderToStaticMarkup(
      <RemoteTerminalScreen text="$ ls" typing={{ type: () => {} }} />,
    );
    expect(typing).toContain('data-testid="remote-terminal-input"');
    expect(typing).toContain("cursor-text");
  });
});
