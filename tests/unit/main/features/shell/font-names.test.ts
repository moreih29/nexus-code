/**
 * The other names the installed fonts go by, as the system says them: WPF's
 * on Windows, a family's names a line; fontconfig's on Linux.
 */

import { describe, expect, test } from "bun:test";
import { parseFcList, parseNameLines } from "../../../../../src/main/features/shell/font-names";

describe("parseNameLines (Windows)", () => {
  test("keeps the families with another name, each once", () => {
    const text = [
      "Malgun Gothic\t맑은 고딕",
      "Arial",
      "Consolas\tconsolas",
      "MS Gothic\tＭＳ ゴシック\t",
      "",
      "Malgun Gothic\t맑은 고딕",
    ].join("\r\n");
    expect(parseNameLines(text)).toEqual([
      ["Malgun Gothic", "맑은 고딕"],
      ["MS Gothic", "ＭＳ ゴシック"],
    ]);
  });
});

describe("parseFcList (Linux)", () => {
  test("takes a family's first name in each language, a family once", () => {
    const text = [
      "NanumGothic,나눔고딕\ten,ko",
      "NanumGothic,나눔고딕\ten,ko",
      "Noto Sans CJK JP,Noto Sans CJK JP Black\ten,en",
      "Noto Sans CJK KR,Noto Sans CJK KR Bold,본고딕\ten,en,ko",
      "DejaVu Sans Mono\ten",
      "",
    ].join("\n");
    expect(parseFcList(text)).toEqual([
      ["NanumGothic", "나눔고딕"],
      ["Noto Sans CJK KR", "본고딕"],
    ]);
  });
});
