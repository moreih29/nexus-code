import { describe, expect, test } from "bun:test";
import type { MonacoRange } from "../../../src/shared/monaco-range";

describe("MonacoRange", () => {
  test("is assignable as an interface with all four fields", () => {
    const range: MonacoRange = {
      startLineNumber: 1,
      startColumn: 1,
      endLineNumber: 2,
      endColumn: 10,
    };
    expect(range.startLineNumber).toBe(1);
    expect(range.startColumn).toBe(1);
    expect(range.endLineNumber).toBe(2);
    expect(range.endColumn).toBe(10);
  });
});
