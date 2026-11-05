/**
 * Text in encodings other than UTF-8: guessed from its bytes and the
 * user's languages, decoded, and written back byte for byte.
 */
import { describe, expect, test } from "bun:test";
import {
  bytesFromBase64,
  bytesToBase64,
  decodeBytes,
  encodeText,
  encodingsToTry,
  guessEncoding,
  type TextEncoding,
} from "../../../../../../src/renderer/services/editor/encoding/text-encoding";

// Bun's TextDecoder lacks some single-byte encodings Chromium has (KOI8-R,
// Windows-1251, ISO-8859-2, ...), so these use only those it has.
const bytes = (...values: number[]) => Uint8Array.from(values);

/** "한글" in EUC-KR, "日本" in Shift_JIS, "café" in Windows-1252. */
const EUC_KR = bytes(0xc7, 0xd1, 0xb1, 0xdb);
const SHIFT_JIS = bytes(0x93, 0xfa, 0x96, 0x7b);
const LATIN = bytes(0x63, 0x61, 0x66, 0xe9);

describe("encodingsToTry", () => {
  test("follows the user's languages, each encoding once", () => {
    expect(encodingsToTry(["ko-KR", "en-US"])).toEqual(["euc-kr"]);
    expect(encodingsToTry(["ja", "zh-CN", "ko"])).toEqual([
      "shift_jis",
      "euc-jp",
      "gbk",
      "big5",
      "euc-kr",
    ]);
    expect(encodingsToTry(["zh-TW"])).toEqual(["big5", "gbk"]);
    expect(encodingsToTry(["en", "fr"])).toEqual([]);
  });
});

describe("guessEncoding", () => {
  test("UTF-16 by its byte-order mark", () => {
    expect(guessEncoding(bytes(0xff, 0xfe, 0x68, 0), ["euc-kr"])).toBe("utf-16le");
    expect(guessEncoding(bytes(0xfe, 0xff, 0, 0x68), ["euc-kr"])).toBe("utf-16be");
  });

  test("the first of the user's encodings the bytes are valid in", () => {
    expect(guessEncoding(EUC_KR, ["euc-kr"])).toBe("euc-kr");
    expect(guessEncoding(SHIFT_JIS, ["shift_jis", "euc-jp"])).toBe("shift_jis");
  });

  test("Windows-1252 when none takes them", () => {
    expect(guessEncoding(LATIN, [])).toBe("windows-1252");
    // 0xE9 0x00 is no EUC-KR character.
    expect(guessEncoding(bytes(0xe9, 0x00), ["euc-kr"])).toBe("windows-1252");
  });
});

describe("encodeText", () => {
  const cases: [TextEncoding, Uint8Array, string][] = [
    ["euc-kr", EUC_KR, "한글"],
    ["shift_jis", SHIFT_JIS, "日本"],
    ["windows-1252", LATIN, "café"],
    ["windows-1253", bytes(0xc1, 0xe2, 0xe3), "Αβγ"],
    ["gbk", bytes(0xd6, 0xd0, 0xce, 0xc4), "中文"],
    ["big5", bytes(0xa4, 0xa4, 0xa4, 0xe5), "中文"],
  ];

  test.each(cases)("%s decodes and writes back the same bytes", (encoding, raw, text) => {
    expect(decodeBytes(raw, encoding)).toBe(text);
    const encoded = encodeText(`${text}\nok`, encoding);
    expect(encoded.ok && [...encoded.bytes]).toEqual([...raw, 0x0a, 0x6f, 0x6b]);
  });

  test("UTF-16 is written with its byte-order mark, which decoding drops", () => {
    const le = encodeText("hi", "utf-16le");
    expect(le.ok && [...le.bytes]).toEqual([0xff, 0xfe, 0x68, 0, 0x69, 0]);
    const be = encodeText("hi", "utf-16be");
    expect(be.ok && [...be.bytes]).toEqual([0xfe, 0xff, 0, 0x68, 0, 0x69]);
    expect(decodeBytes(bytes(0xff, 0xfe, 0x68, 0, 0x69, 0), "utf-16le")).toBe("hi");
  });

  test("UTF-8 with BOM keeps its mark", () => {
    const encoded = encodeText("a", "utf8-bom");
    expect(encoded.ok && [...encoded.bytes]).toEqual([0xef, 0xbb, 0xbf, 0x61]);
  });

  test("a character the encoding has no bytes for is named, with where it is", () => {
    expect(encodeText("한글\nab日本", "euc-kr")).toEqual({
      ok: true,
      bytes: expect.any(Uint8Array),
    });
    expect(encodeText("ok\nab😀", "euc-kr")).toEqual({
      ok: false,
      unencodable: { char: "😀", line: 2, column: 3 },
    });
    expect(encodeText("한", "windows-1252")).toEqual({
      ok: false,
      unencodable: { char: "한", line: 1, column: 1 },
    });
  });
});

test("base64 round trip", () => {
  const all = Uint8Array.from({ length: 256 }, (_, i) => i);
  expect([...bytesFromBase64(bytesToBase64(all))]).toEqual([...all]);
});
