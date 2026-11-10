/** How nexus settings set reads a typed value for each type of setting. */
import { describe, expect, test } from "bun:test";
import { parseSettingValue } from "../../../../src/shared/cli/settings";

describe("parseSettingValue", () => {
  test("reads on and off, and their other words", () => {
    const shape = { type: "boolean" } as const;
    for (const word of ["on", "TRUE", "yes", "1"]) {
      expect(parseSettingValue(shape, word)).toEqual({ value: true });
    }
    for (const word of ["off", "false", "No", "0"]) {
      expect(parseSettingValue(shape, word)).toEqual({ value: false });
    }
    expect(parseSettingValue(shape, "maybe")).toEqual({ error: '"maybe" is not on or off' });
  });

  test("takes a choice as listed, case aside", () => {
    const shape = { type: "choice", choices: ["block", "bar"] } as const;
    expect(parseSettingValue(shape, "Bar")).toEqual({ value: "bar" });
    expect(parseSettingValue(shape, "beam")).toEqual({
      error: '"beam" is not one of block, bar',
    });
  });

  test("keeps a number within its range, and an integer whole", () => {
    const integer = { type: "integer", min: 8, max: 32 } as const;
    expect(parseSettingValue(integer, " 14 ")).toEqual({ value: 14 });
    expect(parseSettingValue(integer, "14.5")).toEqual({ error: '"14.5" is not a whole number' });
    expect(parseSettingValue(integer, "40")).toEqual({ error: "40 is not within 8..32" });
    expect(parseSettingValue(integer, "")).toEqual({ error: '"" is not a number' });
    const number = { type: "number", min: 0.2, max: 1 } as const;
    expect(parseSettingValue(number, "0.85")).toEqual({ value: 0.85 });
    expect(parseSettingValue(number, "0")).toEqual({ error: "0 is not within 0.2..1" });
  });

  test("takes text as typed, within its length and pattern", () => {
    const shape = {
      type: "text",
      maxLength: 8,
      pattern: { test: /^[a-z ]*$/, says: "letters only" },
    } as const;
    expect(parseSettingValue(shape, " a b ")).toEqual({ value: " a b " });
    expect(parseSettingValue(shape, "")).toEqual({ value: "" });
    expect(parseSettingValue(shape, "abcdefghi")).toEqual({
      error: "it is longer than 8 characters",
    });
    expect(parseSettingValue(shape, "a;b")).toEqual({ error: "letters only" });
  });
});
