/**
 * Unit tests for the browser URL classifier.
 *
 * Covers 12 input categories:
 *   1.  http://  explicit scheme                        → navigate (as-is)
 *   2.  https:// explicit scheme                        → navigate (as-is)
 *   3.  localhost (with path)                           → navigate (http://)
 *   4.  127.0.0.1 (with port)                           → navigate (http://)
 *   5.  Raw IPv4 address                                → navigate (http://)
 *   6.  example.com (simple domain)                     → navigate (https://)
 *   7.  sub.example.co.kr (multi-level TLD)             → navigate (https://)
 *   8.  Plain search query (no dot, spaces)             → search (Google)
 *   9.  file:// scheme                                  → navigate (as-is)
 *  10.  javascript: scheme                              → blocked
 *  11.  data: scheme                                    → blocked
 *  12.  about: scheme                                   → blocked
 */

import { describe, expect, it, test } from "bun:test";
import { classifyUrl } from "../../../../../src/renderer/services/browser/url-classifier";

// ---------------------------------------------------------------------------
// 1–2. Explicit scheme (http:// and https://) — navigates as-is
// ---------------------------------------------------------------------------

describe("classifyUrl — explicit scheme (navigate as-is)", () => {
  test.each([
    ["http://example.com",          "http://example.com"],
    ["http://example.com/path?q=1", "http://example.com/path?q=1"],
    ["https://example.com",         "https://example.com"],
    ["https://example.com/page#section", "https://example.com/page#section"],
  ] as const)("%s → navigate %s", (input, expectedUrl) => {
    const result = classifyUrl(input);
    expect(result.kind).toBe("navigate");
    expect(result.url).toBe(expectedUrl);
  });
});

// ---------------------------------------------------------------------------
// 3–5. localhost / 127.0.0.1 / raw IPv4 — prepend http://
// ---------------------------------------------------------------------------

describe("classifyUrl — local addresses (http:// prefix)", () => {
  test.each([
    ["localhost",         "http://localhost"],
    ["localhost/app",     "http://localhost/app"],
    ["localhost:3000",    "http://localhost:3000"],
    ["127.0.0.1",         "http://127.0.0.1"],
    ["127.0.0.1:8080",    "http://127.0.0.1:8080"],
    ["192.168.1.1",       "http://192.168.1.1"],
    ["10.0.0.1:4000",     "http://10.0.0.1:4000"],
  ] as const)("%s → navigate %s", (input, expectedUrl) => {
    const result = classifyUrl(input);
    expect(result.kind).toBe("navigate");
    expect(result.url).toBe(expectedUrl);
  });
});

// ---------------------------------------------------------------------------
// 6–7. Domain names — prepend https://
// ---------------------------------------------------------------------------

describe("classifyUrl — domain names (https:// prefix)", () => {
  test.each([
    ["example.com",             "https://example.com"],
    ["example.com/path",        "https://example.com/path"],
    ["sub.example.co.kr",       "https://sub.example.co.kr"],
    ["api.service.io/v2/items", "https://api.service.io/v2/items"],
  ] as const)("%s → navigate %s", (input, expectedUrl) => {
    const result = classifyUrl(input);
    expect(result.kind).toBe("navigate");
    expect(result.url).toBe(expectedUrl);
  });
});

// ---------------------------------------------------------------------------
// 8. Plain search query
// ---------------------------------------------------------------------------

describe("classifyUrl — search query", () => {
  it("returns Google search for a plain phrase", () => {
    const result = classifyUrl("hello world");
    expect(result.kind).toBe("search");
    expect(result.url).toBe("https://www.google.com/search?q=hello%20world");
  });

  it("returns Google search for a phrase with spaces and punctuation", () => {
    const result = classifyUrl("how to use react hooks?");
    expect(result.kind).toBe("search");
    expect(result.url).toContain("https://www.google.com/search?q=");
    expect(result.url).toContain("react");
  });

  it("trims whitespace before classifying", () => {
    const result = classifyUrl("  hello world  ");
    expect(result.kind).toBe("search");
    expect(result.url).toBe("https://www.google.com/search?q=hello%20world");
  });
});

// ---------------------------------------------------------------------------
// 9. file:// scheme — navigate (as-is)
//
// Local-file navigation is opt-in.  webSecurity + sandbox on the WebContents
// still enforce same-origin and cross-document constraints, so allowing the
// scheme through the classifier does not relax the renderer's overall policy.
// ---------------------------------------------------------------------------

describe("classifyUrl — file:// scheme (navigate)", () => {
  test.each([
    ["file:///Users/x/notes.html", "file:///Users/x/notes.html"],
    ["file://localhost/path",      "file://localhost/path"],
  ] as const)("%s → navigate %s", (input, expectedUrl) => {
    const result = classifyUrl(input);
    expect(result.kind).toBe("navigate");
    expect(result.url).toBe(expectedUrl);
  });
});

// ---------------------------------------------------------------------------
// 9b. Absolute file path — auto-prefix file://
//
// Users that type `/Users/...` (omitting the file:// scheme) should land on
// the same local file as `file:///Users/...`.  No other rule starts with a
// leading slash so this is an unambiguous shortcut.
// ---------------------------------------------------------------------------

describe("classifyUrl — absolute file path (auto-prefix file://)", () => {
  test.each([
    ["/Users/kih/workspaces/notes.html", "file:///Users/kih/workspaces/notes.html"],
    ["/etc/hosts",                        "file:///etc/hosts"],
  ] as const)("%s → navigate %s", (input, expectedUrl) => {
    const result = classifyUrl(input);
    expect(result.kind).toBe("navigate");
    expect(result.url).toBe(expectedUrl);
  });
});

// ---------------------------------------------------------------------------
// 9c. Path-like input WITHOUT leading slash — must NOT be classified as
// https://domain.com.  Falls through to search.
//
// `Users/kih/foo.html` matches the loose domain-like regex because `.html`
// is 2-6 letters and looks like a TLD, but the slash before the dot is the
// telltale sign that this is a path, not a domain.  The guard added in the
// classifier rule 5 must catch this; otherwise auto-prefix turns it into
// `https://users/kih/foo.html` which fails with ERR_NAME_NOT_RESOLVED.
// ---------------------------------------------------------------------------

describe("classifyUrl — path-like input without leading slash (search fallback)", () => {
  it("does not auto-prefix https:// when the slash precedes the dot", () => {
    const result = classifyUrl("Users/kih/foo.html");
    expect(result.kind).toBe("search");
    // Confirm it didn't sneak through as https://users/kih/foo.html.
    expect(result.url).not.toContain("//users/");
  });

  it("falls through to search for path-like input ending in another extension", () => {
    const result = classifyUrl("documents/report.pdf");
    expect(result.kind).toBe("search");
  });

  // The complementary positive case: real domain with a path/extension stays
  // a navigate.  Pins that we only excluded the slash-before-dot inputs.
  it("still navigates https:// for a real domain followed by a slash-path", () => {
    const result = classifyUrl("example.com/foo.html");
    expect(result.kind).toBe("navigate");
    expect(result.url).toBe("https://example.com/foo.html");
  });
});

// ---------------------------------------------------------------------------
// 10–12. Blocked schemes: javascript:, data:, about:
// ---------------------------------------------------------------------------

describe("classifyUrl — blocked schemes", () => {
  // Each row: [input, schemeWordInError]
  test.each([
    ["javascript:alert(1)", "javascript"],
    ["data:text/html,<h1>test</h1>", "data"],
    ["about:blank",  "about"],
  ] as const)("%s → blocked (error contains '%s')", (input, schemeWord) => {
    const result = classifyUrl(input);
    expect(result.kind).toBe("blocked");
    expect(result.error).toBeDefined();
    expect(result.error).toContain(schemeWord);
  });

  // Additional blocked cases without inspecting the error message
  test.each([
    ["JavaScript:void(0)", "javascript: mixed case"],
    ["about:newtab",       "about: alternate page"],
  ] as const)("%s → blocked (%s)", (input) => {
    const result = classifyUrl(input);
    expect(result.kind).toBe("blocked");
  });
});
