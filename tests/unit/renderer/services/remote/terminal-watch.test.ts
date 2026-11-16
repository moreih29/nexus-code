/** A watched terminal's text: what changed, from where it first differs, and its end that fits. */
import { describe, expect, test } from "bun:test";
import {
  applyTextChange,
  fitScreen,
  fitText,
  screenChange,
  textChange,
} from "../../../../../src/renderer/services/remote/terminal-watch";

describe("a terminal's text as it changes", () => {
  test("sends only the bottom when the bottom is redrawn, all of it when it scrolled", () => {
    expect(textChange("a\nb\nc", "a\nb\nc")).toBeNull();
    expect(textChange("a\nb\n⠋ working", "a\nb\n⠙ working")).toEqual({
      start: 4,
      text: "⠙ working",
    });
    expect(textChange("a\nb", "b\nc")).toEqual({ start: 0, text: "b\nc" });
    expect(textChange("a\nb\nc", "a\nb")).toEqual({ start: 3, text: "" });
  });

  test("the change makes the new text of the old", () => {
    for (const [was, now] of [
      ["$ ls", "$ ls\nREADME.md"],
      ["a😀b", "a😁b"],
      ["long line", "long"],
    ] as const) {
      const change = textChange(was, now);
      expect(change).not.toBeNull();
      expect(applyTextChange(was, change as NonNullable<typeof change>)).toBe(now);
    }
  });

  test("does not split an emoji's surrogate pair", () => {
    const change = textChange("a😀", "a😁");
    expect(change?.start).toBe(1);
  });

  test("keeps the end of a text too long, from a line's start", () => {
    const text = Array.from({ length: 1000 }, (_, i) => `line ${i}`).join("\n");
    const fit = fitText(text, 2000);
    expect(new TextEncoder().encode(fit).length).toBeLessThanOrEqual(2000);
    expect(fit.endsWith("line 999")).toBe(true);
    expect(fit.startsWith("line ")).toBe(true);
    expect(fitText("short", 2000)).toBe("short");
  });
});

describe("a terminal's cursor as it moves", () => {
  test("goes with each change, and alone, the text kept, when only it moved", () => {
    const was = { text: "$ git sta", caret: { line: 0, column: 9 } };
    expect(screenChange(was, { text: "$ git stat", caret: { line: 0, column: 10 } })).toEqual({
      start: 9,
      text: "t",
      caret: { line: 0, column: 10 },
    });
    // The left arrow: the text as it was.
    const moved = screenChange(was, { text: "$ git sta", caret: { line: 0, column: 8 } });
    expect(moved).toEqual({ start: 9, text: "", caret: { line: 0, column: 8 } });
    expect(applyTextChange(was.text, moved as NonNullable<typeof moved>)).toBe(was.text);
    expect(screenChange(was, { ...was })).toBeNull();
  });

  test("hidden, a change tells none", () => {
    const was = { text: "> ", caret: { line: 0, column: 2 } };
    expect(screenChange(was, { text: "> " })).toEqual({ start: 2, text: "" });
    expect(screenChange({ text: "> " }, { text: "> " })).toBeNull();
    // A watch without the cursor sends as it did.
    expect(screenChange({ text: "a" }, { text: "ab" })).toEqual({ start: 1, text: "b" });
  });

  test("goes up with the lines a text too long loses; above them, it is not told", () => {
    const text = Array.from({ length: 1000 }, (_, i) => `line ${i}`).join("\n");
    const fit = fitScreen({ text, caret: { line: 999, column: 3 } }, 2000);
    const kept = fit.text.split("\n").length;
    expect(fit.caret).toEqual({ line: kept - 1, column: 3 });
    expect(fit.text.split("\n")[fit.caret?.line ?? -1]).toBe("line 999");
    expect(fitScreen({ text, caret: { line: 2, column: 0 } }, 2000).caret).toBeUndefined();
    const small = { text: "a\nb", caret: { line: 1, column: 1 } };
    expect(fitScreen(small)).toBe(small);
  });
});
