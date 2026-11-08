/**
 * The composer's text box grows to 240px in any tab, and in a tall one to
 * 30% of the column it sits in.
 */

import { describe, expect, it } from "bun:test";
import { maxTextHeight } from "../../../../../src/renderer/components/chat/composer-height";

describe("maxTextHeight", () => {
  it("keeps 240px where 30% of the column would be less", () => {
    expect(maxTextHeight(423)).toBe(240);
    expect(maxTextHeight(800)).toBe(240);
  });

  it("takes 30% of a tall column", () => {
    expect(maxTextHeight(828)).toBe(248);
    expect(maxTextHeight(1200)).toBe(360);
  });

  it("keeps 240px for a column not laid out yet", () => {
    expect(maxTextHeight(0)).toBe(240);
  });
});
