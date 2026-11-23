import { describe, expect, test } from "bun:test";

import {
  isOccludingOverlay,
  overlapsBrowserView,
} from "../../../../../src/renderer/services/browser/suspend-auto";

interface FakeSpec {
  isMonacoWidget?: boolean;
  insideMonaco?: boolean;
  ariaHidden?: boolean;
  insideInert?: boolean;
}

function fakeEl(spec: FakeSpec): Element {
  return {
    matches: () => Boolean(spec.isMonacoWidget),
    closest: (selector: string) => {
      if (selector === "[inert]") return spec.insideInert ? ({} as Element) : null;
      return spec.insideMonaco || spec.isMonacoWidget ? ({} as Element) : null;
    },
    getAttribute: (name: string) => (name === "aria-hidden" && spec.ariaHidden ? "true" : null),
  } as unknown as Element;
}

describe("isOccludingOverlay", () => {
  test("rejects Monaco's closed Find/Replace widget (the regression)", () => {
    expect(isOccludingOverlay(fakeEl({ insideMonaco: true, ariaHidden: true }))).toBe(false);
  });

  test("rejects an open Monaco widget (find visible, role=dialog, not hidden)", () => {
    expect(isOccludingOverlay(fakeEl({ insideMonaco: true, ariaHidden: false }))).toBe(false);
  });

  test("rejects a Monaco overflow widget mounted outside .monaco-editor (matched by class)", () => {
    expect(isOccludingOverlay(fakeEl({ isMonacoWidget: true, insideMonaco: false }))).toBe(false);
  });

  test("rejects any aria-hidden overlay node", () => {
    expect(isOccludingOverlay(fakeEl({ ariaHidden: true }))).toBe(false);
  });

  test("rejects an overlay left open in an inactive (inert) workspace panel", () => {
    expect(isOccludingOverlay(fakeEl({ insideInert: true }))).toBe(false);
  });

  test("accepts a genuine, visible Radix overlay (dialog / menu / popper)", () => {
    expect(isOccludingOverlay(fakeEl({}))).toBe(true);
  });
});

interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

function rect({ left, top, width, height }: Box): DOMRect {
  return { left, top, width, height, right: left + width, bottom: top + height } as DOMRect;
}

function fakeTooltip(box: Box, transform = "translate(10px, 20px)"): Element {
  return {
    style: { transform },
    getBoundingClientRect: () => rect(box),
  } as unknown as Element;
}

function fakeSlot(box: Box, inert = false): Element {
  return {
    closest: () => (inert ? ({} as Element) : null),
    getBoundingClientRect: () => rect(box),
  } as unknown as Element;
}

describe("overlapsBrowserView", () => {
  const page = { left: 200, top: 100, width: 800, height: 600 };

  test("ignores a tooltip over the tab strip, clear of the page", () => {
    const tooltip = fakeTooltip({ left: 220, top: 60, width: 80, height: 24 });
    expect(overlapsBrowserView(tooltip, [fakeSlot(page)])).toBe(false);
  });

  test("counts a tooltip that reaches into the page", () => {
    const tooltip = fakeTooltip({ left: 220, top: 90, width: 80, height: 24 });
    expect(overlapsBrowserView(tooltip, [fakeSlot(page)])).toBe(true);
  });

  test("ignores browser views of inactive workspaces and hidden tabs", () => {
    const tooltip = fakeTooltip({ left: 220, top: 90, width: 80, height: 24 });
    const slots = [fakeSlot(page, true), fakeSlot({ left: 0, top: 0, width: 0, height: 0 })];
    expect(overlapsBrowserView(tooltip, slots)).toBe(false);
  });

  test("counts the toast stack where it covers a browser tab", () => {
    const toasts = fakeTooltip({ left: 640, top: 560, width: 360, height: 80 }, "");
    expect(overlapsBrowserView(toasts, [fakeSlot(page)])).toBe(true);
  });

  test("reports a tooltip Radix has not positioned yet", () => {
    const tooltip = fakeTooltip(
      { left: 0, top: -48, width: 80, height: 24 },
      "translate(0, -200%)",
    );
    expect(overlapsBrowserView(tooltip, [fakeSlot(page)])).toBe("unplaced");
  });
});
