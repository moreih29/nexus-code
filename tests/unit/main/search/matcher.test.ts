import { describe, expect, test } from "bun:test";
import {
  compileSearchRegExp,
  findMatchesInBuffer,
  InvalidSearchPatternError,
} from "../../../../src/main/search/matcher";
import type { TextSearchQuery } from "../../../../src/shared/types/search";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function query(overrides: Partial<TextSearchQuery> & { pattern: string }): TextSearchQuery {
  return {
    isRegExp: false,
    isCaseSensitive: false,
    isWordMatch: false,
    includes: [],
    excludes: [],
    maxResults: 2000,
    maxFileSize: 5 * 1024 * 1024,
    ...overrides,
  };
}

function bufOf(text: string): Buffer {
  return Buffer.from(text, "utf8");
}

// ---------------------------------------------------------------------------
// compileSearchRegExp
// ---------------------------------------------------------------------------

describe("compileSearchRegExp — literal hit / miss", () => {
  test("matches literal text", () => {
    const re = compileSearchRegExp(query({ pattern: "foo" }));
    expect(re.test("foo bar")).toBe(true);
    expect(re.test("baz")).toBe(false);
  });

  test("escapes regex metacharacters in literal mode", () => {
    const re = compileSearchRegExp(query({ pattern: "a.b" }));
    // dot is escaped — should not match "axb"
    expect(re.test("axb")).toBe(false);
    expect(re.test("a.b")).toBe(true);
  });
});

describe("compileSearchRegExp — case sensitivity", () => {
  test("case-insensitive by default", () => {
    const re = compileSearchRegExp(query({ pattern: "FOO" }));
    expect(re.test("foo")).toBe(true);
  });

  test("case-sensitive when requested", () => {
    const re = compileSearchRegExp(query({ pattern: "FOO", isCaseSensitive: true }));
    expect(re.test("foo")).toBe(false);
    expect(re.test("FOO")).toBe(true);
  });
});

describe("compileSearchRegExp — whole word", () => {
  test("whole-word: matches standalone word, not substring", () => {
    const re = compileSearchRegExp(query({ pattern: "foo", isWordMatch: true }));
    expect(re.test("foo bar")).toBe(true);
    expect(re.test("foobar")).toBe(false);
  });

  test("whole-word suppressed when regex source starts/ends with \\B", () => {
    // isRegExp=true, source starts with \B → leading \b not added
    const re = compileSearchRegExp(
      query({ pattern: "\\Bfoo\\B", isRegExp: true, isWordMatch: true }),
    );
    // \Bfoo\B matches "foo" in the middle of a word, e.g. "afoobar"
    expect(re.test("afoobar")).toBe(true);
    // and does NOT require word boundaries
    expect(re.test("foo")).toBe(false); // \B at start fails at word boundary
  });
});

describe("compileSearchRegExp — regex mode with capture groups", () => {
  test("capture groups work in regex mode", () => {
    const re = compileSearchRegExp(query({ pattern: "(foo|bar)", isRegExp: true }));
    // Regex has 'g' flag — reset lastIndex before each test call.
    re.lastIndex = 0;
    expect(re.test("foo")).toBe(true);
    re.lastIndex = 0;
    expect(re.test("bar")).toBe(true);
    re.lastIndex = 0;
    expect(re.test("baz")).toBe(false);
  });
});

describe("compileSearchRegExp — invalid regex throws", () => {
  test("invalid regex pattern throws InvalidSearchPatternError", () => {
    expect(() => compileSearchRegExp(query({ pattern: "[invalid", isRegExp: true }))).toThrow(
      InvalidSearchPatternError,
    );
  });
});

// ---------------------------------------------------------------------------
// findMatchesInBuffer
// ---------------------------------------------------------------------------

describe("findMatchesInBuffer — empty buffer", () => {
  test("returns [] for empty buffer", () => {
    const re = compileSearchRegExp(query({ pattern: "foo" }));
    expect(findMatchesInBuffer(Buffer.alloc(0), re, 100)).toEqual([]);
  });
});

describe("findMatchesInBuffer — binary buffer", () => {
  test("returns [] for buffer with NUL byte in first 512 bytes", () => {
    const buf = Buffer.alloc(100, 0x41);
    buf[10] = 0x00;
    const re = compileSearchRegExp(query({ pattern: "A" }));
    expect(findMatchesInBuffer(buf, re, 100)).toEqual([]);
  });
});

describe("findMatchesInBuffer — per-file cap", () => {
  test("clamps results to perFileCap", () => {
    // 10 lines each containing "foo"
    const text = Array.from({ length: 10 }, () => "foo").join("\n");
    const re = compileSearchRegExp(query({ pattern: "foo" }));
    const matches = findMatchesInBuffer(bufOf(text), re, 5);
    expect(matches.length).toBe(5);
  });
});

describe("findMatchesInBuffer — multi-line matches", () => {
  test("returns matches with correct line and col", () => {
    const text = "hello world\nfoo bar\nbaz";
    const re = compileSearchRegExp(query({ pattern: "foo", isCaseSensitive: true }));
    const matches = findMatchesInBuffer(bufOf(text), re, 100);
    expect(matches.length).toBe(1);
    expect(matches[0].range.line).toBe(1);
    expect(matches[0].range.startCol).toBe(0);
    expect(matches[0].range.endCol).toBe(3);
    expect(matches[0].preview).toBe("foo bar");
  });

  test("returns multiple matches across lines", () => {
    const text = "foo\nbar\nfoo";
    const re = compileSearchRegExp(query({ pattern: "foo", isCaseSensitive: true }));
    const matches = findMatchesInBuffer(bufOf(text), re, 100);
    expect(matches.length).toBe(2);
    expect(matches[0].range.line).toBe(0);
    expect(matches[1].range.line).toBe(2);
  });
});

describe("findMatchesInBuffer — zero-width match guard", () => {
  test("(?=foo) lookahead does not cause infinite loop", () => {
    const text = "foofoo";
    const re = compileSearchRegExp(query({ pattern: "(?=foo)", isRegExp: true }));
    // Should complete without hanging; just verify it returns something
    const matches = findMatchesInBuffer(bufOf(text), re, 100);
    expect(Array.isArray(matches)).toBe(true);
  });
});

describe("findMatchesInBuffer — UTF-8 BOM stripped", () => {
  test("BOM-prefixed file still matches correctly on line 0", () => {
    const bom = Buffer.from([0xef, 0xbb, 0xbf]);
    const text = Buffer.from("foo bar", "utf8");
    const buf = Buffer.concat([bom, text]);
    const re = compileSearchRegExp(query({ pattern: "foo", isCaseSensitive: true }));
    const matches = findMatchesInBuffer(buf, re, 100);
    expect(matches.length).toBe(1);
    expect(matches[0].range.line).toBe(0);
    expect(matches[0].range.startCol).toBe(0);
  });
});
