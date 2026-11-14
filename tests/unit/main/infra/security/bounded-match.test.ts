/** Patterns from agents and other devices, tested where none can hold up the app. */
import { describe, expect, test } from "bun:test";
import {
  firstMatch,
  PatternTooSlowError,
} from "../../../../../src/main/infra/security/bounded-match";

describe("a pattern tested within a time", () => {
  test("gives the first line it matches, or none", () => {
    expect(firstMatch(/ready on :\d+/, ["building", "ready on :3000", "ready on :4000"])).toBe(
      "ready on :3000",
    );
    expect(firstMatch(/error/, ["building", "done"])).toBeUndefined();
  });

  test("one that backtracks without end stops, and the next is tested as before", () => {
    expect(() => firstMatch(/( +)+$/, [`${" ".repeat(40)}x`], 50)).toThrow(PatternTooSlowError);
    expect(firstMatch(/x$/, [`${" ".repeat(40)}x`])).toBe(`${" ".repeat(40)}x`);
  });
});
