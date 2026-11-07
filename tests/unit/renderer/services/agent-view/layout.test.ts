/**
 * The agent view's panels: agents held by session key in a split tree, each
 * change a new layout. Taking an agent out never closes its session; a
 * panel left empty closes unless it is the only one.
 */
import { describe, expect, it } from "bun:test";
import { Grid, type SplitNode } from "../../../../../src/renderer/engine";
import {
  type AgentLayout,
  activeKey,
  closeLeaf,
  cycleLeaf,
  cycleTab,
  emptyLayout,
  heldKeys,
  leafHolding,
  leafShowing,
  moveKey,
  openKey,
  parseSessionKey,
  placeKey,
  pruneKeys,
  removeKey,
  sanitizeLayout,
  selectKey,
  setActiveLeaf,
  splitLeaf,
} from "../../../../../src/renderer/services/agent-view/layout";

const A = "ws-a:t1";
const B = "ws-a:t2";
const C = "ws-b:t3";

let splits = 0;

/**
 * Names the panel a split makes `leafId`, and the split itself apart from
 * every other (a split takes the second id it asks for).
 */
function named(leafId: string): () => string {
  let used = false;
  return () => {
    if (used) return `split${++splits}`;
    used = true;
    return leafId;
  };
}

function leaves(layout: AgentLayout) {
  return Grid.allLeaves(layout.root).map((leaf) => ({
    id: leaf.id,
    tabIds: leaf.tabIds,
    activeTabId: leaf.activeTabId,
  }));
}

/** One panel holding `keys`, the last in front. */
function onePanel(...keys: string[]): AgentLayout {
  let layout = emptyLayout(() => "p1");
  for (const key of keys) layout = openKey(layout, key);
  return layout;
}

/** p1 holding A and B (B in front), beside p2 holding C, the active one. */
function twoPanels(): AgentLayout {
  return {
    root: {
      kind: "split",
      id: "s0",
      orientation: "horizontal",
      ratio: 0.5,
      first: { kind: "leaf", id: "p1", tabIds: [A, B], activeTabId: B },
      second: { kind: "leaf", id: "p2", tabIds: [C], activeTabId: C },
    },
    activeLeafId: "p2",
  };
}

describe("parseSessionKey", () => {
  it("splits at the first colon", () => {
    expect(parseSessionKey("ws:tab")).toEqual({ workspaceId: "ws", tabId: "tab" });
  });

  it("names nothing without both parts", () => {
    expect(parseSessionKey("ws")).toBeNull();
    expect(parseSessionKey(":tab")).toBeNull();
    expect(parseSessionKey("ws:")).toBeNull();
  });
});

describe("openKey", () => {
  it("adds an agent to the active panel and shows it", () => {
    const layout = onePanel(A, B);
    expect(leaves(layout)).toEqual([{ id: "p1", tabIds: [A, B], activeTabId: B }]);
    expect(activeKey(layout)).toBe(B);
  });

  it("brings an agent a panel already holds to its front, making that panel active", () => {
    const layout = setActiveLeaf(twoPanels(), "p2");
    const next = openKey(layout, A);
    expect(next.activeLeafId).toBe("p1");
    expect(leafShowing(next.root, A)).toBe("p1");
    expect(heldKeys(next.root)).toEqual([A, B, C]);
  });

  it("adds to the panel named", () => {
    const next = openKey(twoPanels(), "ws-b:t4", "p1");
    expect(leafHolding(next.root, "ws-b:t4")?.id).toBe("p1");
    expect(next.activeLeafId).toBe("p1");
  });
});

describe("selectKey", () => {
  it("brings the agent to the front of its panel", () => {
    const next = selectKey(onePanel(A, B), "p1", A);
    expect(activeKey(next)).toBe(A);
  });

  it("ignores an agent the panel does not hold", () => {
    const layout = onePanel(A);
    expect(selectKey(layout, "p1", C)).toBe(layout);
  });
});

describe("removeKey", () => {
  it("shows the agent next to the one taken out", () => {
    const next = removeKey(selectKey(onePanel(A, B, C), "p1", B), B);
    expect(leaves(next)).toEqual([{ id: "p1", tabIds: [A, C], activeTabId: C }]);
  });

  it("closes a panel it leaves empty", () => {
    const next = removeKey(twoPanels(), C);
    expect(leaves(next)).toEqual([{ id: "p1", tabIds: [A, B], activeTabId: B }]);
    expect(next.activeLeafId).toBe("p1");
  });

  it("keeps the only panel, empty", () => {
    const next = removeKey(onePanel(A), A);
    expect(leaves(next)).toEqual([{ id: "p1", tabIds: [], activeTabId: null }]);
  });
});

describe("closeLeaf", () => {
  it("closes a panel and its agents leave the view", () => {
    const next = closeLeaf(twoPanels(), "p1");
    expect(leaves(next)).toEqual([{ id: "p2", tabIds: [C], activeTabId: C }]);
    expect(next.activeLeafId).toBe("p2");
  });

  it("empties the only panel", () => {
    expect(leaves(closeLeaf(onePanel(A, B), "p1"))).toEqual([
      { id: "p1", tabIds: [], activeTabId: null },
    ]);
  });
});

describe("splitLeaf", () => {
  it("moves the front agent into the new panel when others stay", () => {
    const next = splitLeaf(onePanel(A, B), "p1", "right", undefined, named("p2"));
    expect(leaves(next)).toEqual([
      { id: "p1", tabIds: [A], activeTabId: A },
      { id: "p2", tabIds: [B], activeTabId: B },
    ]);
    expect(next.activeLeafId).toBe("p2");
    expect(next.root.kind === "split" && next.root.orientation).toBe("horizontal");
  });

  it("starts the new panel empty beside a panel of one", () => {
    const next = splitLeaf(onePanel(A), "p1", "down", undefined, named("p2"));
    expect(leaves(next)).toEqual([
      { id: "p1", tabIds: [A], activeTabId: A },
      { id: "p2", tabIds: [], activeTabId: null },
    ]);
    expect(next.root.kind === "split" && next.root.orientation).toBe("vertical");
  });

  it("does nothing for a panel's only agent split beside itself", () => {
    const layout = onePanel(A);
    expect(splitLeaf(layout, "p1", "right", A, named("p2"))).toBe(layout);
  });

  it("moves the agent named out of its panel, which closes when left empty", () => {
    const next = splitLeaf(twoPanels(), "p1", "down", C, named("p3"));
    expect(leaves(next)).toEqual([
      { id: "p1", tabIds: [A, B], activeTabId: B },
      { id: "p3", tabIds: [C], activeTabId: C },
    ]);
  });
});

describe("moveKey and placeKey", () => {
  it("reorders within a panel", () => {
    const next = moveKey(onePanel(A, B, C), C, "p1", 0);
    expect(leaves(next)[0]?.tabIds).toEqual([C, A, B]);
  });

  it("moves between panels at the index given", () => {
    const next = moveKey(twoPanels(), A, "p2", 0);
    expect(leaves(next)).toEqual([
      { id: "p1", tabIds: [B], activeTabId: B },
      { id: "p2", tabIds: [A, C], activeTabId: A },
    ]);
  });

  it("adds an agent no panel holds", () => {
    const next = moveKey(onePanel(A), C, "p1");
    expect(leaves(next)[0]?.tabIds).toEqual([A, C]);
  });

  it("brings an agent dropped back on its own panel to the front, in place", () => {
    const next = placeKey(onePanel(A, B), A, "p1");
    expect(leaves(next)).toEqual([{ id: "p1", tabIds: [A, B], activeTabId: A }]);
  });

  it("splits toward the side dropped on", () => {
    const next = placeKey(twoPanels(), A, "p2", "left", undefined, named("p3"));
    expect(leaves(next).map((leaf) => leaf.tabIds)).toEqual([[B], [A], [C]]);
    expect(next.activeLeafId).toBe("p3");
  });
});

describe("cycling", () => {
  it("steps the front agent of the active panel, wrapping around", () => {
    const layout = onePanel(A, B, C);
    expect(activeKey(cycleTab(layout, 1))).toBe(A);
    expect(activeKey(cycleTab(layout, -1))).toBe(B);
  });

  it("steps the active panel in reading order, wrapping around", () => {
    const layout = twoPanels();
    expect(cycleLeaf(layout, 1).activeLeafId).toBe("p1");
    expect(cycleLeaf(cycleLeaf(layout, 1), -1).activeLeafId).toBe("p2");
  });
});

describe("pruneKeys", () => {
  it("takes out the agents whose tab is gone and closes the panels left empty", () => {
    const next = pruneKeys(twoPanels(), (key) => key !== C && key !== B);
    expect(leaves(next)).toEqual([{ id: "p1", tabIds: [A], activeTabId: A }]);
  });

  it("keeps the layout when every agent is alive", () => {
    const layout = twoPanels();
    expect(pruneKeys(layout, () => true)).toBe(layout);
  });
});

describe("sanitizeLayout", () => {
  it("keeps each agent in one panel, a front agent the panel holds, and an active panel that exists", () => {
    const root: SplitNode = {
      kind: "split",
      id: "s1",
      orientation: "horizontal",
      ratio: 0.5,
      first: { kind: "leaf", id: "p1", tabIds: [A, "bad", B], activeTabId: "gone" },
      second: { kind: "leaf", id: "p2", tabIds: [A, C], activeTabId: A },
    };
    const layout = sanitizeLayout(root, "missing");
    expect(leaves(layout)).toEqual([
      { id: "p1", tabIds: [A, B], activeTabId: A },
      { id: "p2", tabIds: [C], activeTabId: C },
    ]);
    expect(layout.activeLeafId).toBe("p1");
  });
});
