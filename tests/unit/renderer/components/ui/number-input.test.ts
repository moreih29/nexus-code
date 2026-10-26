import { describe, expect, it } from "bun:test";
import { parseNumberInputText } from "../../../../../src/renderer/components/ui/number-input";

const FONT = { min: 8, max: 32, step: 1 };

describe("parseNumberInputText", () => {
  it("accepts an in-range whole number", () => {
    expect(parseNumberInputText("14", FONT)).toBe(14);
    expect(parseNumberInputText(" 14 ", FONT)).toBe(14);
  });

  it("snaps a fraction to the step grid", () => {
    expect(parseNumberInputText("13.5", FONT)).toBe(14);
    expect(parseNumberInputText("13.4", FONT)).toBe(13);
  });

  it("clamps to the range", () => {
    expect(parseNumberInputText("2", FONT)).toBe(8);
    expect(parseNumberInputText("99", FONT)).toBe(32);
  });

  it("keeps the current value for blank or non-numeric text", () => {
    expect(parseNumberInputText("", FONT)).toBeNull();
    expect(parseNumberInputText("   ", FONT)).toBeNull();
    expect(parseNumberInputText("abc", FONT)).toBeNull();
    expect(parseNumberInputText("Infinity", FONT)).toBeNull();
  });
});
