/** A watched terminal's text: what changed, from where it first differs, and its end that fits. */
import { describe, expect, test } from "bun:test";
import {
  applyTextChange,
  fitText,
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
