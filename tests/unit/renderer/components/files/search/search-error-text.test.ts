import { describe, expect, it } from "bun:test";
import i18next from "i18next";
import { searchErrorText } from "../../../../../../src/renderer/components/files/search/search-error-text";
import {
  regexErrorReason,
  validateRegexPattern,
} from "../../../../../../src/renderer/components/files/search/validate-regex-pattern";

const t = i18next.getFixedT(null, "files");

describe("validateRegexPattern", () => {
  it("reports the engine's reason without its own lead", () => {
    const result = validateRegexPattern("foo(", true);
    expect(result.valid).toBe(false);
    const error = (result as { error: string }).error;
    expect(error.length).toBeGreaterThan(0);
    expect(error).not.toContain("Invalid regular expression");
  });

  it("strips V8's lead, which repeats the pattern", () => {
    expect(regexErrorReason("Invalid regular expression: /foo(/: Unterminated group")).toBe(
      "Unterminated group",
    );
    expect(regexErrorReason("Invalid regular expression: /a/: b(/u: Unterminated group")).toBe(
      "Unterminated group",
    );
    // The input's wrapper then reads once.
    expect(t("search.invalidRegex", { error: "Unterminated group" })).toBe(
      "Invalid regular expression: Unterminated group",
    );
  });
});

describe("searchErrorText", () => {
  it("explains a pattern the agent's engine rejects", () => {
    expect(
      searchErrorText(
        'Invalid search pattern "(?=x)": error parsing regexp: invalid or unsupported Perl syntax: `(?=`',
        t,
      ),
    ).toBe("Search can't use this regular expression: invalid or unsupported Perl syntax: `(?=`");
  });

  it("handles a quoted pattern with escaped quotes", () => {
    expect(
      searchErrorText(
        'Invalid search pattern "a\\"(\\\\1)": error parsing regexp: invalid escape sequence: `\\1`',
        t,
      ),
    ).toBe("Search can't use this regular expression: invalid escape sequence: `\\1`");
  });

  it("falls back to the generic line without a message and keeps other messages", () => {
    expect(searchErrorText(undefined, t)).toBe("Search failed");
    expect(searchErrorText("Agent request timed out", t)).toBe("Agent request timed out");
  });
});
