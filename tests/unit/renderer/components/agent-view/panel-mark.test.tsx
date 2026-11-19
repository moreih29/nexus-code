/**
 * The mark of a session the agent view's panels have, the same on this computer's rows
 * and another computer's: shown in front of a panel, or held behind another tab.
 */
import { describe, expect, test } from "bun:test";
import type { SplitNode } from "../../../../../src/renderer/engine";

const { panelPlaceOf } = await import(
  "../../../../../src/renderer/components/agent-view/panel-mark"
);

const root: SplitNode = {
  kind: "split",
  id: "s1",
  orientation: "horizontal",
  ratio: 0.5,
  first: { kind: "leaf", id: "l1", tabIds: ["ws:a", "ws:b"], activeTabId: "ws:a" },
  second: { kind: "leaf", id: "l2", tabIds: ["remote:d2:w1:t1"], activeTabId: "remote:d2:w1:t1" },
};

describe("panelPlaceOf", () => {
  test("a session in front of a panel is shown, one behind another tab held", () => {
    expect(panelPlaceOf(root, "ws:a")).toBe("shown");
    expect(panelPlaceOf(root, "ws:b")).toBe("held");
    expect(panelPlaceOf(root, "remote:d2:w1:t1")).toBe("shown");
  });

  test("a session no panel has has no place", () => {
    expect(panelPlaceOf(root, "ws:c")).toBeNull();
  });
});
