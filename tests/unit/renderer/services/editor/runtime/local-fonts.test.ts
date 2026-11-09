/**
 * The installed fonts the font fields offer: each family once, in order,
 * and the ones a name typed matches, best first, by their own name or
 * another they go by (맑은 고딕 for Malgun Gothic).
 */

import { describe, expect, test } from "bun:test";
import {
  familyNamed,
  fontAliases,
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

const ALIASES = fontAliases(FAMILIES, [
  ["Nanum Gothic", "나눔고딕"],
  ["apple sd gothic neo", "Apple SD 산돌고딕 Neo"],
  ["Gulim", "굴림"],
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

  test("finds a family by another of its names, ranked by the best", () => {
    expect(matchFamilies(FAMILIES, "나눔", ALIASES)).toEqual(["Nanum Gothic"]);
    expect(matchFamilies(FAMILIES, "산돌", ALIASES)).toEqual(["Apple SD Gothic Neo"]);
    // Within the other name of each, so in the families' order.
    expect(matchFamilies(FAMILIES, "고딕", ALIASES)).toEqual([
      "Apple SD Gothic Neo",
      "Nanum Gothic",
    ]);
    expect(matchFamilies(FAMILIES, "나눔고딕", ALIASES)).toEqual(["Nanum Gothic"]);
    expect(matchFamilies(FAMILIES, "굴림", ALIASES)).toEqual([]);
  });
});

describe("fontAliases", () => {
  test("gives a listed family the names of its group that are not listed, whatever their case", () => {
    expect([...ALIASES]).toEqual([
      ["Nanum Gothic", ["나눔고딕"]],
      ["Apple SD Gothic Neo", ["Apple SD 산돌고딕 Neo"]],
    ]);
  });

  test("gives none where each name is a family of the list", () => {
    const families = ["JetBrainsMono NF", "JetBrainsMono Nerd Font", "Malgun Gothic"];
    const aliases = fontAliases(families, [
      ["JetBrainsMono NF", "JetBrainsMono Nerd Font"],
      ["Malgun Gothic", "맑은 고딕"],
      ["Malgun Gothic", "맑은 고딕"],
    ]);
    expect([...aliases]).toEqual([["Malgun Gothic", ["맑은 고딕"]]]);
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

  test("is the family by another of its whole names", () => {
    expect(familyNamed(FAMILIES, " 나눔고딕 ", ALIASES)).toBe("Nanum Gothic");
    expect(familyNamed(FAMILIES, "apple sd 산돌고딕 neo", ALIASES)).toBe("Apple SD Gothic Neo");
    expect(familyNamed(FAMILIES, "나눔", ALIASES)).toBeUndefined();
    expect(familyNamed(FAMILIES, "나눔고딕")).toBeUndefined();
  });
});
