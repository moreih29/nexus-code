import { describe, expect, test } from "bun:test";
import {
  insertionIndex,
  tabInsertion,
} from "../../../../../src/renderer/components/agent-view/drag";

const rect = (left: number, width: number) => ({ left, width, right: left + width });

function strip(widths: number[], scrollLeft = 0): HTMLElement {
  let left = 100 - scrollLeft;
  const tabs = widths.map((width, i) => {
    const at = left;
    left += width + 2;
    return { dataset: { agentTab: `k${i}` }, getBoundingClientRect: () => rect(at, width) };
  });
  return {
    scrollLeft,
    getBoundingClientRect: () => rect(100, 300),
    querySelectorAll: () => tabs,
  } as unknown as HTMLElement;
}

describe("tabInsertion", () => {
  test("left of a tab's middle goes before it, the line at its left edge", () => {
    const s = strip([80, 80, 80]);
    expect(tabInsertion(s, 101)).toEqual({ x: 0, before: "k0" });
    expect(tabInsertion(s, 141)).toEqual({ x: 82, before: "k1" });
    expect(tabInsertion(s, 230)).toEqual({ x: 164, before: "k2" });
  });

  test("past the last tab's middle goes after it", () => {
    expect(tabInsertion(strip([80, 80]), 300)).toEqual({ x: 162, before: null });
  });

  test("the line is in the scrolled content, so it scrolls with the tabs", () => {
    expect(tabInsertion(strip([80, 80, 80], 50), 150)).toEqual({ x: 82, before: "k1" });
  });

  test("a panel with no tabs puts it first", () => {
    expect(tabInsertion(strip([]), 200)).toEqual({ x: 0, before: null });
  });
});

describe("insertionIndex", () => {
  const tabs = ["a", "b", "c", "d"];

  test("moving along the same panel counts without the tab itself", () => {
    expect(insertionIndex(tabs, "b", "d")).toBe(2);
    expect(insertionIndex(tabs, "d", "a")).toBe(0);
    expect(insertionIndex(tabs, "a", null)).toBe(3);
  });

  test("before itself or the tab after it, it stays where it is", () => {
    expect(insertionIndex(tabs, "b", "b")).toBe(1);
    expect(insertionIndex(tabs, "b", "c")).toBe(1);
  });

  test("from another panel, among all the tabs", () => {
    expect(insertionIndex(tabs, "x", "c")).toBe(2);
    expect(insertionIndex(tabs, "x", null)).toBe(4);
  });
});
