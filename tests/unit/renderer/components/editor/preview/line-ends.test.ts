import { describe, expect, it } from "bun:test";
import {
  type EndMark,
  endMark,
  lineEnds,
} from "../../../../../../src/renderer/components/editor/preview/line-ends";

const TRIANGLE = { type: "triangle", width: "med", length: "med" };

function round(mark: EndMark | undefined): unknown {
  if (!mark) return mark;
  const r = (n: number) => Math.round(n * 100) / 100;
  if (mark.kind === "ellipse") {
    return { ...mark, center: { x: r(mark.center.x), y: r(mark.center.y) }, angle: r(mark.angle) };
  }
  return { kind: mark.kind, points: mark.points.map(({ x, y }) => [r(x), r(y)]) };
}

describe("endMark", () => {
  it("points a triangle out of the line, three line widths long and wide", () => {
    const end = endMark(TRIANGLE, { x: 100, y: 0 }, { x: 0, y: 0 }, 4);
    expect(round(end?.mark)).toEqual({
      kind: "polygon",
      points: [
        [100, 0],
        [88, 6],
        [88, -6],
      ],
    });
    // Into the head, past where the line's square end would show.
    expect(end?.shorten).toBeCloseTo(7.2);
  });

  it("sizes a thin line's ends as a two-point line's", () => {
    const end = endMark(
      { type: "triangle", width: "sm", length: "lg" },
      { x: 0, y: 50 },
      { x: 0, y: 0 },
      0.75,
    );
    // Down the page: ten long, four wide.
    expect(round(end?.mark)).toEqual({
      kind: "polygon",
      points: [
        [0, 50],
        [-2, 40],
        [2, 40],
      ],
    });
  });

  it("leaves an open arrow, a diamond and an oval on the line's end", () => {
    const tip = { x: 0, y: 0 };
    const from = { x: -10, y: 0 };
    expect(endMark({ type: "arrow" }, tip, from, 2)?.shorten).toBe(0);
    expect(round(endMark({ type: "diamond" }, tip, from, 2)?.mark)).toEqual({
      kind: "polygon",
      points: [
        [3, 0],
        [0, 3],
        [-3, 0],
        [0, -3],
      ],
    });
    expect(round(endMark({ type: "oval" }, tip, { x: 0, y: -10 }, 2)?.mark)).toEqual({
      kind: "ellipse",
      center: { x: 0, y: 0 },
      rx: 3,
      ry: 3,
      angle: 90,
    });
  });

  it("draws nothing for no end, or one it does not know", () => {
    expect(endMark({ type: "none" }, { x: 1, y: 0 }, { x: 0, y: 0 }, 1)).toBeNull();
    expect(endMark({}, { x: 1, y: 0 }, { x: 0, y: 0 }, 1)).toBeNull();
    expect(endMark({ type: "spiral" }, { x: 1, y: 0 }, { x: 0, y: 0 }, 1)).toBeNull();
  });
});

describe("lineEnds", () => {
  it("puts the tail's head at the path's end, and stops the line inside it", () => {
    const ends = lineEnds("M 0 0 L 260 0", 2, undefined, TRIANGLE);
    expect(ends?.path).toBe("M 0 0 L 256.4 0");
    expect(round(ends?.marks[0])).toEqual({
      kind: "polygon",
      points: [
        [260, 0],
        [254, 3],
        [254, -3],
      ],
    });
  });

  it("points the head back along the path's first run, as an elbow's", () => {
    const ends = lineEnds("M 0 0 L 130 0 L 130 120 L 260 120", 2, TRIANGLE, TRIANGLE);
    expect(ends?.path).toBe("M 3.6 0 L 130 0 L 130 120 L 256.4 120");
    expect(round(ends?.marks[1])).toEqual({
      kind: "polygon",
      points: [
        [0, 0],
        [6, -3],
        [6, 3],
      ],
    });
  });

  it("takes a curve's way in from its last control point", () => {
    const ends = lineEnds("M 0 0 C 0 50 50 100 100 100", 2, undefined, { type: "arrow" });
    expect(round(ends?.marks[0])).toEqual({
      kind: "polyline",
      points: [
        [94, 103],
        [100, 100],
        [94, 97],
      ],
    });
  });

  it("puts no ends on a line without them, or on a path it cannot read", () => {
    expect(lineEnds("M 0 0 L 10 0", 1, undefined, undefined)).toBeNull();
    expect(lineEnds("M 0 0 L 10 0", 1, { type: "none" }, { type: "none" })).toBeNull();
    expect(lineEnds("M 0 0 L 10 0 Z", 1, undefined, TRIANGLE)).toBeNull();
    expect(lineEnds("M 0 0 A 5 5 0 0 1 10 0", 1, undefined, TRIANGLE)).toBeNull();
    expect(lineEnds("m 0 0 l 10 0", 1, undefined, TRIANGLE)).toBeNull();
    expect(lineEnds("M 0 0", 1, undefined, TRIANGLE)).toBeNull();
  });
});
