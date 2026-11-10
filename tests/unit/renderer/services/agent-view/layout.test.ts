/**
 * The agent view's panels: agents held by session key in a split tree, each
 * change a new layout. Taking an agent out never closes its session; a
 * panel left empty closes unless it is the only one.
 */
import { describe, expect, it } from "bun:test";
import { Grid, type SplitNode } from "../../../../../src/renderer/engine";
import {
  type AgentLayout,
  parseSessionKey,
  sanitizeLayout,
} from "../../../../../src/renderer/services/agent-view/layout";

const A = "ws-a:t1";
const B = "ws-a:t2";
const C = "ws-b:t3";

function leaves(layout: AgentLayout) {
  return Grid.allLeaves(layout.root).map((leaf) => ({
    id: leaf.id,
    tabIds: leaf.tabIds,
    activeTabId: leaf.activeTabId,
  }));
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
