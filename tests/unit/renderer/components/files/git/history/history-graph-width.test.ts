/**
 * Tests for how much of the history list's width the graph may take.
 */
import { describe, expect, it } from "bun:test";
import { capGraphWidth } from "../../../../../../../src/renderer/components/files/git/history/list";

describe("capGraphWidth", () => {
  it("keeps the whole graph when it fits in its share of the list", () => {
    expect(capGraphWidth(64, 400)).toBe(64);
  });

  it("cuts a wide graph down to 40% of a narrow list", () => {
    expect(capGraphWidth(144, 240)).toBe(96);
  });

  it("never cuts the graph below one lane", () => {
    expect(capGraphWidth(144, 20)).toBe(16);
  });

  it("keeps the whole graph until the list has been measured", () => {
    expect(capGraphWidth(144, 0)).toBe(144);
  });
});
