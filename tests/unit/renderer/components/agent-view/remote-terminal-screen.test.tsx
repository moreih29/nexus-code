import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  caretLook,
  lookOf,
  RemoteTerminalScreen,
} from "../../../../../src/renderer/components/agent-view/remote-terminal-screen";

const sixteen = Array.from({ length: 16 }, (_, i) => `#0000${i.toString(16).padStart(2, "0")}`);
const colors = {
  sixteen,
  foreground: "#eeeeee",
  background: "var(--surface-island-bg)",
  cursor: "#ffcc00",
  cursorAccent: "#000000",
};

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

describe("the cursor", () => {
  test("is a block in the cursor's colors with the keyboard here, an outline without", () => {
    expect(caretLook({ bold: true }, colors, true)).toEqual({
      fontWeight: 700,
      color: "#000000",
      backgroundColor: "#ffcc00",
    });
    expect(caretLook({}, colors, false)).toEqual({
      outline: "1px solid #ffcc00",
      outlineOffset: -1,
    });
  });

  test("is drawn on its character, and on blank lines below the text when there", () => {
    const html = renderToStaticMarkup(
      <RemoteTerminalScreen text="$ ls" caret={{ line: 0, column: 2 }} />,
    );
    expect(html).toContain('$ <span style="outline:1px solid');
    expect(html).toContain(">l</span>s</pre>");
    const below = renderToStaticMarkup(
      <RemoteTerminalScreen text="$ sleep 30" caret={{ line: 1, column: 0 }} />,
    );
    expect(below).toContain("$ sleep 30\n<span");
    expect(below).toContain("> </span></pre>");
  });

  test("is not drawn where none is told", () => {
    const html = renderToStaticMarkup(<RemoteTerminalScreen text="$ ls" />);
    expect(html).not.toContain("outline");
  });
});
