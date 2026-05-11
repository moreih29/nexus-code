/**
 * Scenario fixture tests for pure Git history lane assignment.
 */
import { describe, expect, it } from "bun:test";
import {
  initialLaneState,
  type LaneCommit,
  type LaneEdge,
  type LaneSpill,
  type LaneState,
  MAX_LANES,
  reduceLanes,
} from "../../../../../../../src/renderer/components/files/git/history/graph/lane-assign";

function c(sha: string, parents: readonly string[] = []): LaneCommit {
  return { sha, parents: [...parents] };
}

function laneEntries(state: LaneState): [string, number][] {
  return Array.from(state.laneByCommit.entries());
}

function expectLaneState(
  state: LaneState,
  expected: {
    laneByCommit: [string, number][];
    openLanes: readonly (string | null)[];
    edges: readonly LaneEdge[];
    spills?: readonly LaneSpill[];
  },
): void {
  expect(laneEntries(state)).toEqual(expected.laneByCommit);
  expect(state.openLanes).toEqual(expected.openLanes);
  expect(state.edges).toEqual(expected.edges);
  expect(state.spills).toEqual(expected.spills ?? []);
}

function plainState(state: LaneState): {
  openLanes: readonly (string | null)[];
  laneByCommit: [string, number][];
  edges: readonly LaneEdge[];
  spills: readonly LaneSpill[];
} {
  return {
    openLanes: state.openLanes,
    laneByCommit: laneEntries(state),
    edges: state.edges,
    spills: state.spills,
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
      openLanes: [],
      edges: [
        { from: "A", to: "B", fromLane: 0, toLane: 0, kind: "parent" },
        { from: "B", to: "C", fromLane: 0, toLane: 0, kind: "parent" },
      ],
    });
  });

  it("opens a merge parent lane and closes it when both branches reach the root", () => {
    // M
    // |\
    // A B
    // |/
    // R
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
      openLanes: [],
      edges: [
        { from: "M", to: "A", fromLane: 0, toLane: 0, kind: "parent" },
        { from: "M", to: "B", fromLane: 0, toLane: 1, kind: "merge" },
        { from: "A", to: "R", fromLane: 0, toLane: 0, kind: "parent" },
        { from: "B", to: "R", fromLane: 1, toLane: 0, kind: "parent" },
      ],
    });
  });

  it("assigns each extra octopus parent to its own lane", () => {
    // O
    // |\ \
    // A B C
    // | |/
    // R
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
      openLanes: [],
      edges: [
        { from: "O", to: "A", fromLane: 0, toLane: 0, kind: "parent" },
        { from: "O", to: "B", fromLane: 0, toLane: 1, kind: "merge" },
        { from: "O", to: "C", fromLane: 0, toLane: 2, kind: "merge" },
        { from: "A", to: "R", fromLane: 0, toLane: 0, kind: "parent" },
        { from: "B", to: "R", fromLane: 1, toLane: 0, kind: "parent" },
        { from: "C", to: "R", fromLane: 2, toLane: 0, kind: "parent" },
      ],
    });
  });

  it("dedupes criss-cross parents already visible in opposite lanes", () => {
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
        ["B", 2],
        ["Z", 0],
      ],
      openLanes: [],
      edges: [
        { from: "T", to: "L", fromLane: 0, toLane: 0, kind: "parent" },
        { from: "T", to: "R2", fromLane: 0, toLane: 1, kind: "merge" },
        { from: "L", to: "A", fromLane: 0, toLane: 0, kind: "parent" },
        { from: "L", to: "B", fromLane: 0, toLane: 2, kind: "merge" },
        { from: "R2", to: "B", fromLane: 1, toLane: 2, kind: "parent" },
        { from: "R2", to: "A", fromLane: 1, toLane: 0, kind: "merge" },
        { from: "A", to: "Z", fromLane: 0, toLane: 0, kind: "parent" },
        { from: "B", to: "Z", fromLane: 2, toLane: 0, kind: "parent" },
      ],
    });
  });

  it("closes an orphan root after an unrelated graph has already ended", () => {
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
      openLanes: [],
      edges: [{ from: "A", to: "R", fromLane: 0, toLane: 0, kind: "parent" }],
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
      openLanes: ["B"],
      edges: [{ from: "A", to: "B", fromLane: 0, toLane: 0, kind: "parent" }],
    });

    const page2 = reduceLanes(page1, [c("B")]);
    expectLaneState(page2, {
      laneByCommit: [
        ["A", 0],
        ["B", 0],
      ],
      openLanes: [],
      edges: [{ from: "A", to: "B", fromLane: 0, toLane: 0, kind: "parent" }],
    });
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
      ],
      edges: [
        { from: "O", to: "p00", fromLane: 0, toLane: 0, kind: "parent" },
        { from: "O", to: "p01", fromLane: 0, toLane: 1, kind: "merge" },
        { from: "O", to: "p02", fromLane: 0, toLane: 2, kind: "merge" },
        { from: "O", to: "p03", fromLane: 0, toLane: 3, kind: "merge" },
        { from: "O", to: "p04", fromLane: 0, toLane: 4, kind: "merge" },
        { from: "O", to: "p05", fromLane: 0, toLane: 5, kind: "merge" },
        { from: "O", to: "p06", fromLane: 0, toLane: 6, kind: "merge" },
        { from: "O", to: "p07", fromLane: 0, toLane: 7, kind: "merge" },
        { from: "O", to: "p08", fromLane: 0, toLane: 8, kind: "merge" },
        { from: "O", to: "p09", fromLane: 0, toLane: 9, kind: "merge" },
        { from: "O", to: "p10", fromLane: 0, toLane: 10, kind: "merge" },
        { from: "O", to: "p11", fromLane: 0, toLane: 11, kind: "merge" },
        { from: "O", to: "p12", fromLane: 0, toLane: 12, kind: "merge" },
        { from: "O", to: "p13", fromLane: 0, toLane: 13, kind: "merge" },
        { from: "O", to: "p14", fromLane: 0, toLane: 14, kind: "merge" },
        { from: "O", to: "p15", fromLane: 0, toLane: 15, kind: "merge" },
        { from: "O", to: "p16", fromLane: 0, toLane: 16, kind: "merge" },
        { from: "O", to: "p17", fromLane: 0, toLane: 17, kind: "merge" },
        { from: "O", to: "p18", fromLane: 0, toLane: 18, kind: "merge" },
        { from: "O", to: "p19", fromLane: 0, toLane: 19, kind: "merge" },
        { from: "O", to: "p20", fromLane: 0, toLane: 20, kind: "merge" },
        { from: "O", to: "p21", fromLane: 0, toLane: 21, kind: "merge" },
        { from: "O", to: "p22", fromLane: 0, toLane: 22, kind: "merge" },
        { from: "O", to: "p23", fromLane: 0, toLane: 23, kind: "merge" },
        {
          from: "O",
          to: "p24",
          fromLane: 0,
          toLane: 23,
          kind: "merge",
          spilled: true,
        },
      ],
      spills: [{ from: "O", to: "p24", lane: 23, parentIndex: 24 }],
    });
  });

  it("returns equal results for the same inputs without mutating the previous state", () => {
    const previous: LaneState = {
      openLanes: ["B"],
      laneByCommit: new Map([["A", 0]]),
      edges: [{ from: "A", to: "B", fromLane: 0, toLane: 0, kind: "parent" }],
      spills: [{ from: "wide", to: "hidden", lane: 23, parentIndex: 24 }],
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
      edges: [{ from: "A", to: "B", fromLane: 0, toLane: 0, kind: "parent" }],
      spills: [{ from: "wide", to: "hidden", lane: 23, parentIndex: 24 }],
    });
  });
});
