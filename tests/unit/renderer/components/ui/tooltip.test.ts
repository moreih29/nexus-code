/**
 * A tooltip sits under what it describes, above it when there is no room
 * below, and inside the window; its attributes carry the shortcut apart.
 */
import { describe, expect, it } from "bun:test";
import { placeTooltip, tooltipProps } from "../../../../../src/renderer/components/ui/tooltip";

const view = { width: 1000, height: 800 };
const tip = { width: 100, height: 24 };

describe("placeTooltip", () => {
  it("centres the tooltip under the element", () => {
    const anchor = { left: 400, top: 100, width: 40, height: 28 };
    expect(placeTooltip(anchor, tip, view)).toEqual({ left: 370, top: 132 });
  });

  it("goes above when there is no room below", () => {
    const anchor = { left: 400, top: 770, width: 40, height: 28 };
    expect(placeTooltip(anchor, tip, view).top).toBe(770 - 4 - 24);
  });

  it("stays below when there is no room above either", () => {
    const anchor = { left: 400, top: 2, width: 40, height: 790 };
    expect(placeTooltip(anchor, tip, view).top).toBe(796);
  });

  it("is kept inside the window's sides", () => {
    expect(placeTooltip({ left: 0, top: 100, width: 20, height: 20 }, tip, view).left).toBe(4);
    expect(placeTooltip({ left: 990, top: 100, width: 10, height: 20 }, tip, view).left).toBe(896);
  });
});

describe("tooltipProps", () => {
  it("names the label, and the shortcut only when there is one", () => {
    expect(tooltipProps("Close")).toEqual({ "data-tooltip": "Close" });
    expect(tooltipProps("Close", null)).toEqual({ "data-tooltip": "Close" });
    expect(tooltipProps("Close", "⌘W")).toEqual({
      "data-tooltip": "Close",
      "data-tooltip-shortcut": "⌘W",
    });
  });
});
