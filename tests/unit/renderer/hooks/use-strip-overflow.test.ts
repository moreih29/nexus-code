/**
 * A strip of tabs that runs on out of sight fades at the edges it runs past
 * and names the tabs not wholly shown, for the menu of them.
 */
import { describe, expect, it } from "bun:test";
import {
  fadeMask,
  NO_OVERFLOW,
  overflowOf,
} from "../../../../src/renderer/hooks/use-strip-overflow";

const strip = { left: 100, right: 400 };
const tabs = [
  { id: "a", span: { left: 60, right: 160 } },
  { id: "b", span: { left: 160, right: 300 } },
  { id: "c", span: { left: 300, right: 400 } },
  { id: "d", span: { left: 400, right: 520 } },
];

describe("overflowOf", () => {
  it("has nothing out of sight when every tab fits", () => {
    expect(
      overflowOf(strip, { left: 0, width: 300, total: 300 }, [
        { id: "a", span: { left: 100, right: 250 } },
        { id: "b", span: { left: 250, right: 400 } },
      ]),
    ).toEqual(NO_OVERFLOW);
  });

  it("names the tabs cut at either edge, in strip order", () => {
    const overflow = overflowOf(strip, { left: 40, width: 300, total: 460 }, tabs);
    expect(overflow.hidden).toEqual(["a", "d"]);
    expect(overflow.start).toBe(true);
    expect(overflow.end).toBe(true);
  });

  it("runs on past the end only, scrolled to the start", () => {
    const overflow = overflowOf(strip, { left: 0, width: 300, total: 460 }, tabs.slice(1));
    expect(overflow.start).toBe(false);
    expect(overflow.end).toBe(true);
    expect(overflow.hidden).toEqual(["d"]);
  });

  it("takes a pixel of rounding for in sight", () => {
    const overflow = overflowOf(strip, { left: 0.5, width: 300, total: 300.5 }, [
      { id: "a", span: { left: 99.5, right: 400.5 } },
    ]);
    expect(overflow).toEqual(NO_OVERFLOW);
  });
});

describe("fadeMask", () => {
  it("has no mask with nothing out of sight", () => {
    expect(fadeMask(NO_OVERFLOW)).toBeUndefined();
  });

  it("fades only the edges tabs run past", () => {
    const endOnly = fadeMask({ start: false, end: true, hidden: ["d"] });
    expect(endOnly?.startsWith("linear-gradient(to right, #000,")).toBe(true);
    expect(endOnly?.endsWith(", transparent)")).toBe(true);
    const both = fadeMask({ start: true, end: true, hidden: ["a", "d"] });
    expect(both?.startsWith("linear-gradient(to right, transparent,")).toBe(true);
  });
});
