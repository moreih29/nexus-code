import { describe, expect, test } from "bun:test";
import { dictatedText, gapBefore, placeOf } from "../../../../../src/renderer/services/voice/text";

describe("dictated text in a composer", () => {
  test("goes at the caret, between what was before and after it", () => {
    const place = placeOf("Fix the  test", 8);
    expect(dictatedText(place, "flaky", "").text).toBe("Fix the flaky test");
  });

  test("joins the finals as they came, then the partial, adding nothing between", () => {
    // The server starts every segment after the first with its own space.
    const place = placeOf("", 0);
    const live = dictatedText(place, "Hello world. How", " are yo");
    expect(live.text).toBe("Hello world. How are yo");
    expect(live.text.slice(live.partialStart, live.partialEnd)).toBe(" are yo");
    const ko = dictatedText(place, "안녕하세요 반갑습니다", " 오늘");
    expect(ko.text).toBe("안녕하세요 반갑습니다 오늘");
  });

  test("puts a space after a word before the caret, but not after a space or at the start", () => {
    expect(gapBefore("Fix", "the build")).toBe(" ");
    expect(gapBefore("Fix ", "the build")).toBe("");
    expect(gapBefore("", "the build")).toBe("");
    expect(gapBefore("Fix", "")).toBe("");
    expect(dictatedText(placeOf("Fix", 3), "the build", "").text).toBe("Fix the build");
  });

  test("a caret out of range is clamped to the text", () => {
    expect(placeOf("abc", 99)).toEqual({ before: "abc", after: "" });
    expect(placeOf("abc", -1)).toEqual({ before: "", after: "abc" });
  });
});
