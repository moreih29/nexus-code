/** What a terminal program's OSC 52 puts on the clipboard. */
import { describe, expect, test } from "bun:test";
import {
  clipboardTextOf,
  MAX_CLIPBOARD_CHARS,
} from "../../../../../src/renderer/services/terminal/osc-clipboard";

const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64");

describe("a terminal program's clipboard payload", () => {
  test("is its UTF-8 text", () => {
    expect(clipboardTextOf(b64("npm test"))).toBe("npm test");
    expect(clipboardTextOf(b64("저장 ✓"))).toBe("저장 ✓");
  });

  test("is nothing when empty, not base64, or longer than the clipboard takes from it", () => {
    expect(clipboardTextOf("")).toBeNull();
    expect(clipboardTextOf("%%%")).toBeNull();
    expect(clipboardTextOf(b64("x".repeat(MAX_CLIPBOARD_CHARS)))).toBe(
      "x".repeat(MAX_CLIPBOARD_CHARS),
    );
    expect(clipboardTextOf(b64("x".repeat(MAX_CLIPBOARD_CHARS + 1)))).toBeNull();
    expect(clipboardTextOf("A".repeat(MAX_CLIPBOARD_CHARS * 6 + 4))).toBeNull();
  });
});
