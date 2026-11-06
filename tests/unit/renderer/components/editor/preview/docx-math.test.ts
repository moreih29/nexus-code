import { describe, expect, it } from "bun:test";
import {
  isMathRow,
  mathTokensOf,
} from "../../../../../../src/renderer/components/editor/preview/docx-math";

function show(text: string, name = false): string[] {
  return mathTokensOf(text, name).map(
    ({ tag, text, upright }) => `${tag}${upright ? "!" : ""}:${text}`,
  );
}

describe("mathTokensOf", () => {
  it("sets each letter apart, for italic, and a formula's count as a number", () => {
    expect(show("SnO")).toEqual(["mi:S", "mi:n", "mi:O"]);
    expect(show("2")).toEqual(["mn:2"]);
  });

  it("reads a decimal as one number, and signs as operators", () => {
    expect(show("a+b=1.5")).toEqual(["mi:a", "mo:+", "mi:b", "mo:=", "mn:1.5"]);
    expect(show("CO,")).toEqual(["mi:C", "mi:O", "mo:,"]);
  });

  it("writes a hyphen as a minus sign and leaves out spaces", () => {
    expect(show("x - 1")).toEqual(["mi:x", "mo:\u2212", "mn:1"]);
  });

  it("keeps capital Greek letters upright, as Word does, and small ones italic", () => {
    expect(show("ΔG")).toEqual(["mi!:Δ", "mi:G"]);
    expect(show("θ")).toEqual(["mi:θ"]);
  });

  it("keeps a run of other letters as text", () => {
    expect(show("농도=2")).toEqual(["mtext:농도", "mo:=", "mn:2"]);
  });

  it("reads a function's name as one identifier", () => {
    expect(show(" sin ", true)).toEqual(["mi:sin"]);
    expect(show("", true)).toEqual([]);
  });
});

describe("isMathRow", () => {
  it("takes a run's tokens into an equation and its rows, so a sign after a script is binary", () => {
    // x² − 2x + 1: Word starts a run with the minus after the script.
    const rows = ["math", "mrow", "mtd", "msqrt", "mstyle"];
    expect(rows.filter((name) => !isMathRow(name))).toEqual([]);
  });

  it("keeps a run that is a script's, a fraction's or a root's part as one row", () => {
    const parts = ["msub", "msup", "msubsup", "mfrac", "mroot", "munder", "mover", "ms", "mn"];
    expect(parts.filter((name) => isMathRow(name))).toEqual([]);
    expect(isMathRow(undefined)).toBe(false);
  });
});
