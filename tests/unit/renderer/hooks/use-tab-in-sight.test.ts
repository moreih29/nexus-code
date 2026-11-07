/**
 * A strip of tabs scrolls the tab in front into sight, no further than
 * needed, so it is never left past either end.
 */
import { describe, expect, it } from "bun:test";
import { scrollToShow } from "../../../../src/renderer/hooks/use-tab-in-sight";

const strip = { left: 100, right: 400 };

describe("scrollToShow", () => {
  it("leaves a tab in sight where it is", () => {
    expect(scrollToShow(strip, { left: 120, right: 300 })).toBe(0);
  });

  it("brings a tab past the end in, just to the end", () => {
    expect(scrollToShow(strip, { left: 350, right: 520 })).toBe(120);
  });

  it("brings a tab before the start in, just to the start", () => {
    expect(scrollToShow(strip, { left: 40, right: 200 })).toBe(-60);
  });

  it("shows the start of a tab wider than the strip", () => {
    expect(scrollToShow(strip, { left: 250, right: 700 })).toBe(150);
  });
});
