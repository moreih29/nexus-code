import { describe, expect, test } from "bun:test";
import { numberedLines } from "../../../../../src/renderer/components/chat/tool-row";

describe("numberedLines", () => {
  test("splits a Read result's numbers from its code", () => {
    expect(numberedLines("1\tconst a = 1;\n2\t\n3\t}\n")).toEqual({
      numbers: ["1", "2", "3"],
      code: "const a = 1;\n\n}",
    });
  });

  test("reads the arrow form of older versions", () => {
    expect(numberedLines("    9→x\n   10→y")).toEqual({ numbers: ["9", "10"], code: "x\ny" });
  });

  test("is null for text that is not all numbered lines", () => {
    expect(numberedLines("File does not exist.")).toBeNull();
    expect(numberedLines("1\tok\nnot numbered")).toBeNull();
    expect(numberedLines("")).toBeNull();
  });
});
