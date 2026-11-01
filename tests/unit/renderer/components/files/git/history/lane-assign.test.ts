/**
 * Scenario fixture tests for pure Git history lane assignment.
 */
import { describe, expect, it } from "bun:test";
import {
  initialLaneState,
  type LaneCommit,
  type LaneEdge,
  type LaneEdgeKind,
  type LaneSpill,
  type LaneState,
  MAX_LANES,
  type OpenLane,
  reduceLanes,
} from "../../../../../../../src/renderer/components/files/git/history/graph/lane-assign";

function c(sha: string, parents: readonly string[] = []): LaneCommit {
  return { sha, parents: [...parents] };
}

function lane(sha: string, color: number): OpenLane {
  return { sha, color };
}

function edge(
  from: string,
  to: string,
  fromLane: number,
  toLane: number,
  kind: LaneEdgeKind,
  color: number,
): LaneEdge {
  return { from, to, fromLane, toLane, kind, color };
}

function laneEntries(state: LaneState): [string, number][] {
  return Array.from(state.laneByCommit.entries());
}

function colorEntries(state: LaneState): [string, number][] {
  return Array.from(state.colorByCommit.entries());
}

function expectLaneState(
  state: LaneState,
  expected: {
    laneByCommit: [string, number][];
    colorByCommit?: [string, number][];
    openLanes: readonly (OpenLane | null)[];
    edges: readonly LaneEdge[];
    spills?: readonly LaneSpill[];
    mainline?: string | null;
  },
): void {
  expect(laneEntries(state)).toEqual(expected.laneByCommit);
  if (expected.colorByCommit) expect(colorEntries(state)).toEqual(expected.colorByCommit);
  expect(state.openLanes).toEqual(expected.openLanes);
  expect(state.edges).toEqual(expected.edges);
  expect(state.spills).toEqual(expected.spills ?? []);
  expect(state.mainline).toBe(expected.mainline ?? null);
}

function plainState(state: LaneState) {
  return {
    openLanes: state.openLanes,
    laneByCommit: laneEntries(state),
    colorByCommit: colorEntries(state),
    edges: state.edges,
    spills: state.spills,
    mainline: state.mainline,
    nextColor: state.nextColor,
  };
}

describe("reduceLanes — graph topology fixtures", () => {
  it("keeps a linear first-parent chain in lane 0", () => {
    // A
    // |
    // B
    // |
    // C
    const state = reduceLanes(initialLaneState(), [c("A", ["B"]), c("B", ["C"]), c("C")]);

    expectLaneState(state, {
      laneByCommit: [
        ["A", 0],
        ["B", 0],
        ["C", 0],
      ],
      colorByCommit: [
        ["A", 0],
        ["B", 0],
        ["C", 0],
      ],
      openLanes: [],
      edges: [edge("A", "B", 0, 0, "parent", 0), edge("B", "C", 0, 0, "parent", 0)],
    });
  });

  it("keeps a merged branch in its own lane until it reaches the commit it joins", () => {
    // M
    // |\
    // A B
    // | |
    // R-+
    const state = reduceLanes(initialLaneState(), [
      c("M", ["A", "B"]),
      c("A", ["R"]),
      c("B", ["R"]),
      c("R"),
    ]);

    expectLaneState(state, {
      laneByCommit: [
        ["M", 0],
        ["A", 0],
        ["B", 1],
        ["R", 0],
      ],
      colorByCommit: [
        ["M", 0],
        ["A", 0],
        ["B", 1],
        ["R", 0],
      ],
      openLanes: [],
      edges: [
        edge("M", "A", 0, 0, "parent", 0),
        edge("M", "B", 0, 1, "merge", 1),
        edge("A", "R", 0, 0, "parent", 0),
        edge("B", "R", 1, 1, "parent", 1),
      ],
    });
  });

  it("assigns each extra octopus parent to its own lane and color", () => {
    // O
    // |\ \
    // A B C
    // | | |
    // R-+-+
    const state = reduceLanes(initialLaneState(), [
      c("O", ["A", "B", "C"]),
      c("A", ["R"]),
      c("B", ["R"]),
      c("C", ["R"]),
      c("R"),
    ]);

    expectLaneState(state, {
      laneByCommit: [
        ["O", 0],
        ["A", 0],
        ["B", 1],
        ["C", 2],
        ["R", 0],
      ],
      colorByCommit: [
        ["O", 0],
        ["A", 0],
        ["B", 1],
        ["C", 2],
        ["R", 0],
      ],
      openLanes: [],
      edges: [
        edge("O", "A", 0, 0, "parent", 0),
        edge("O", "B", 0, 1, "merge", 1),
        edge("O", "C", 0, 2, "merge", 2),
        edge("A", "R", 0, 0, "parent", 0),
        edge("B", "R", 1, 1, "parent", 1),
        edge("C", "R", 2, 2, "parent", 2),
      ],
    });
  });

  it("joins every line waiting for a commit into the lowest of their lanes", () => {
    // T
    // |\
    // L R2
    // |\ /|
    // A B
    // |/
    // Z
    const state = reduceLanes(initialLaneState(), [
      c("T", ["L", "R2"]),
      c("L", ["A", "B"]),
      c("R2", ["B", "A"]),
      c("A", ["Z"]),
      c("B", ["Z"]),
      c("Z"),
    ]);

    expectLaneState(state, {
      laneByCommit: [
        ["T", 0],
        ["L", 0],
        ["R2", 1],
        ["A", 0],
        ["B", 1],
        ["Z", 0],
      ],
      colorByCommit: [
        ["T", 0],
        ["L", 0],
        ["R2", 1],
        ["A", 0],
        ["B", 1],
        ["Z", 0],
      ],
      openLanes: [],
      edges: [
        edge("T", "L", 0, 0, "parent", 0),
        edge("T", "R2", 0, 1, "merge", 1),
        edge("L", "A", 0, 0, "parent", 0),
        edge("L", "B", 0, 2, "merge", 2),
        edge("R2", "B", 1, 1, "parent", 1),
        edge("R2", "A", 1, 0, "merge", 0),
        edge("A", "Z", 0, 0, "parent", 0),
        edge("B", "Z", 1, 1, "parent", 1),
      ],
    });
  });

  it("keeps the first commit's first-parent line in lane 0 when a branch reaches its parent first", () => {
    // M2
    // | \
    // |  F1
    // M1 |
    // |  |
    // P--+
    const state = reduceLanes(initialLaneState(), [
      c("M2", ["M1", "F1"]),
      c("F1", ["P"]),
      c("M1", ["P"]),
      c("P"),
    ]);

    expectLaneState(state, {
      laneByCommit: [
        ["M2", 0],
        ["F1", 1],
        ["M1", 0],
        ["P", 0],
      ],
      openLanes: [],
      edges: [
        edge("M2", "M1", 0, 0, "parent", 0),
        edge("M2", "F1", 0, 1, "merge", 1),
        edge("F1", "P", 1, 1, "parent", 1),
        edge("M1", "P", 0, 0, "parent", 0),
      ],
    });
  });

  it("keeps a branch's rail through all of its commits", () => {
    // M
    // |\
    // A F2
    // | |
    // | F1
    // | |
    // P-+
    const state = reduceLanes(initialLaneState(), [
      c("M", ["A", "F2"]),
      c("A", ["P"]),
      c("F2", ["F1"]),
      c("F1", ["P"]),
      c("P"),
    ]);

    expectLaneState(state, {
      laneByCommit: [
        ["M", 0],
        ["A", 0],
        ["F2", 1],
        ["F1", 1],
        ["P", 0],
      ],
      openLanes: [],
      edges: [
        edge("M", "A", 0, 0, "parent", 0),
        edge("M", "F2", 0, 1, "merge", 1),
        edge("A", "P", 0, 0, "parent", 0),
        edge("F2", "F1", 1, 1, "parent", 1),
        edge("F1", "P", 1, 1, "parent", 1),
      ],
    });
  });

  it("gives lane 0 to an unrelated root once the first commit's line has ended", () => {
    // A    O
    // |
    // R
    const state = reduceLanes(initialLaneState(), [c("A", ["R"]), c("R"), c("O")]);

    expectLaneState(state, {
      laneByCommit: [
        ["A", 0],
        ["R", 0],
        ["O", 0],
      ],
      colorByCommit: [
        ["A", 0],
        ["R", 0],
        ["O", 1],
      ],
      openLanes: [],
      edges: [edge("A", "R", 0, 0, "parent", 0)],
    });
  });

  it("treats a detached root-like commit as a one-row lane that closes immediately", () => {
    // D is detached/root-like from the reducer perspective: no parents to keep open.
    const state = reduceLanes(initialLaneState(), [c("D")]);

    expectLaneState(state, {
      laneByCommit: [["D", 0]],
      openLanes: [],
      edges: [],
    });
  });
});

describe("reduceLanes — streaming and safety regressions", () => {
  it("keeps page 1 lanes open and closes them when page 2 delivers the parent", () => {
    // Page 1 paints A and leaves B open; page 2 later resolves B as a root.
    const page1 = reduceLanes(initialLaneState(), [c("A", ["B"])]);
    expectLaneState(page1, {
      laneByCommit: [["A", 0]],
      openLanes: [lane("B", 0)],
      edges: [edge("A", "B", 0, 0, "parent", 0)],
      mainline: "B",
    });

    const page2 = reduceLanes(page1, [c("B")]);
    expectLaneState(page2, {
      laneByCommit: [
        ["A", 0],
        ["B", 0],
      ],
      openLanes: [],
      edges: [edge("A", "B", 0, 0, "parent", 0)],
    });
  });

  it("keeps lane 0 for the first commit's line across pages", () => {
    // Page 1 leaves the mainline waiting for B and a branch waiting for P.
    const page1 = reduceLanes(initialLaneState(), [c("M", ["B", "F"]), c("F", ["P"])]);
    // Page 2 starts with B, which must land back in lane 0.
    const page2 = reduceLanes(page1, [c("B", ["P"]), c("P")]);

    expect(page2.laneByCommit.get("B")).toBe(0);
    expect(page2.laneByCommit.get("P")).toBe(0);
    expect(page2.laneByCommit.get("F")).toBe(1);
  });

  it("caps visible lanes at MAX_LANES and emits a spill edge for the extra parent", () => {
    const parents = [
      "p00",
      "p01",
      "p02",
      "p03",
      "p04",
      "p05",
      "p06",
      "p07",
      "p08",
      "p09",
      "p10",
      "p11",
      "p12",
      "p13",
      "p14",
      "p15",
      "p16",
      "p17",
      "p18",
      "p19",
      "p20",
      "p21",
      "p22",
      "p23",
      "p24",
    ];
    const state = reduceLanes(initialLaneState(), [c("O", parents)]);

    expect(MAX_LANES).toBe(24);
    expectLaneState(state, {
      laneByCommit: [["O", 0]],
      openLanes: [
        lane("p00", 0),
        lane("p01", 1),
        lane("p02", 2),
        lane("p03", 3),
        lane("p04", 4),
        lane("p05", 5),
        lane("p06", 6),
        lane("p07", 7),
        lane("p08", 8),
        lane("p09", 9),
        lane("p10", 10),
        lane("p11", 11),
        lane("p12", 12),
        lane("p13", 13),
        lane("p14", 14),
        lane("p15", 15),
        lane("p16", 16),
        lane("p17", 17),
        lane("p18", 18),
        lane("p19", 19),
        lane("p20", 20),
        lane("p21", 21),
        lane("p22", 22),
        lane("p23", 23),
      ],
      edges: [
        edge("O", "p00", 0, 0, "parent", 0),
        edge("O", "p01", 0, 1, "merge", 1),
        edge("O", "p02", 0, 2, "merge", 2),
        edge("O", "p03", 0, 3, "merge", 3),
        edge("O", "p04", 0, 4, "merge", 4),
        edge("O", "p05", 0, 5, "merge", 5),
        edge("O", "p06", 0, 6, "merge", 6),
        edge("O", "p07", 0, 7, "merge", 7),
        edge("O", "p08", 0, 8, "merge", 8),
        edge("O", "p09", 0, 9, "merge", 9),
        edge("O", "p10", 0, 10, "merge", 10),
        edge("O", "p11", 0, 11, "merge", 11),
        edge("O", "p12", 0, 12, "merge", 12),
        edge("O", "p13", 0, 13, "merge", 13),
        edge("O", "p14", 0, 14, "merge", 14),
        edge("O", "p15", 0, 15, "merge", 15),
        edge("O", "p16", 0, 16, "merge", 16),
        edge("O", "p17", 0, 17, "merge", 17),
        edge("O", "p18", 0, 18, "merge", 18),
        edge("O", "p19", 0, 19, "merge", 19),
        edge("O", "p20", 0, 20, "merge", 20),
        edge("O", "p21", 0, 21, "merge", 21),
        edge("O", "p22", 0, 22, "merge", 22),
        edge("O", "p23", 0, 23, "merge", 23),
        { ...edge("O", "p24", 0, 23, "merge", 0), spilled: true },
      ],
      spills: [{ from: "O", to: "p24", lane: 23, parentIndex: 24 }],
      mainline: "p00",
    });
  });

  it("returns equal results for the same inputs without mutating the previous state", () => {
    const previous: LaneState = {
      openLanes: [lane("B", 0)],
      laneByCommit: new Map([["A", 0]]),
      colorByCommit: new Map([["A", 0]]),
      edges: [edge("A", "B", 0, 0, "parent", 0)],
      spills: [{ from: "wide", to: "hidden", lane: 23, parentIndex: 24 }],
      mainline: "B",
      nextColor: 1,
    };
    const before = plainState(previous);
    const page = [c("B")];

    const first = reduceLanes(previous, page);
    const second = reduceLanes(previous, page);

    expect(plainState(previous)).toEqual(before);
    expect(plainState(first)).toEqual(plainState(second));
    expectLaneState(first, {
      laneByCommit: [
        ["A", 0],
        ["B", 0],
      ],
      openLanes: [],
      edges: [edge("A", "B", 0, 0, "parent", 0)],
      spills: [{ from: "wide", to: "hidden", lane: 23, parentIndex: 24 }],
    });
  });
});
