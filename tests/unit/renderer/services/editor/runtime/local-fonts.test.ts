/**
 * The installed fonts the font fields offer: each family once, in order,
 * and the ones a name typed matches, best first.
 */

import { describe, expect, test } from "bun:test";
import {
  familyNamed,
  matchFamilies,
  uniqueFamilies,
} from "../../../../../../src/renderer/services/editor/runtime/local-fonts";

const FAMILIES = uniqueFamilies([
  "Nanum Gothic",
  "D2Coding",
  "Fira Code",
  "D2CodingLigature Nerd Font",
  "Nanum Gothic",
  "Apple SD Gothic Neo",
  "JetBrainsMono Nerd Font",
  "Noto Sans KR",
  "Code New Roman",
  " ",
]);

describe("uniqueFamilies", () => {
  test("lists each family once, in order, case aside", () => {
    expect(FAMILIES).toEqual([
      "Apple SD Gothic Neo",
      "Code New Roman",
      "D2Coding",
      "D2CodingLigature Nerd Font",
      "Fira Code",
      "JetBrainsMono Nerd Font",
      "Nanum Gothic",
      "Noto Sans KR",
    ]);
  });
});

describe("matchFamilies", () => {
  test("puts the name itself first, then names starting with it, then a word, then the rest", () => {
    expect(matchFamilies(FAMILIES, "cod")).toEqual([
      "Code New Roman",
      "Fira Code",
      "D2Coding",
      "D2CodingLigature Nerd Font",
    ]);
    expect(matchFamilies(FAMILIES, "d2coding")).toEqual(["D2Coding", "D2CodingLigature Nerd Font"]);
  });

  test("ignores case and the spaces around it", () => {
    expect(matchFamilies(FAMILIES, "  NERD ")).toEqual([
      "D2CodingLigature Nerd Font",
      "JetBrainsMono Nerd Font",
    ]);
  });

  test("matches all for nothing typed, none for a name no font has", () => {
    expect(matchFamilies(FAMILIES, "")).toEqual(FAMILIES);
    expect(matchFamilies(FAMILIES, "Comic")).toEqual([]);
  });
});

describe("familyNamed", () => {
  test("is the family by its whole name, whatever its case", () => {
    expect(familyNamed(FAMILIES, "fira code")).toBe("Fira Code");
    expect(familyNamed(FAMILIES, " Noto Sans KR ")).toBe("Noto Sans KR");
  });

  test("is none for part of a name, or nothing", () => {
    expect(familyNamed(FAMILIES, "Fira")).toBeUndefined();
    expect(familyNamed(FAMILIES, "")).toBeUndefined();
  });
});
