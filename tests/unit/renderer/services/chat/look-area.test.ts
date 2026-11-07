import { describe, expect, test } from "bun:test";
import { LOOK_AREA_ATTR, lookAreaOf } from "../../../../../src/renderer/services/chat/look-area";

/** A tab's root that finds `area` for the marker, as Element.closest does. */
function rootIn(area: object | null) {
  return {
    closest: (selector: string) => (selector === `[${LOOK_AREA_ATTR}]` ? area : null),
  } as unknown as Element;
}

describe("lookAreaOf", () => {
  test("is the area around the tab", () => {
    const area = { id: "panels" };
    expect(lookAreaOf(rootIn(area))).toBe(area as unknown as HTMLElement);
  });

  test("is null for a tab out of it, or not mounted", () => {
    expect(lookAreaOf(rootIn(null))).toBeNull();
    expect(lookAreaOf(null)).toBeNull();
  });
});
