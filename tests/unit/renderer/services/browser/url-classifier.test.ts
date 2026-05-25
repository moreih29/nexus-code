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

import { describe, expect, it } from "bun:test";
import { classifyUrl } from "../../../../../src/renderer/services/browser/url-classifier";

// ---------------------------------------------------------------------------
// 1. http:// explicit scheme
// ---------------------------------------------------------------------------

describe("classifyUrl — explicit http:// scheme", () => {
  it("navigates as-is for http://example.com", () => {
    const result = classifyUrl("http://example.com");
    expect(result.kind).toBe("navigate");
    expect(result.url).toBe("http://example.com");
  });

  it("preserves path and query for http://example.com/path?q=1", () => {
    const result = classifyUrl("http://example.com/path?q=1");
    expect(result.kind).toBe("navigate");
    expect(result.url).toBe("http://example.com/path?q=1");
  });
});

// ---------------------------------------------------------------------------
// 2. https:// explicit scheme
// ---------------------------------------------------------------------------

describe("classifyUrl — explicit https:// scheme", () => {
  it("navigates as-is for https://example.com", () => {
    const result = classifyUrl("https://example.com");
    expect(result.kind).toBe("navigate");
    expect(result.url).toBe("https://example.com");
  });

  it("preserves fragment for https://example.com/page#section", () => {
    const result = classifyUrl("https://example.com/page#section");
    expect(result.kind).toBe("navigate");
    expect(result.url).toBe("https://example.com/page#section");
  });
});

// ---------------------------------------------------------------------------
// 3. localhost
// ---------------------------------------------------------------------------

describe("classifyUrl — localhost", () => {
  it("adds http:// for bare localhost", () => {
    const result = classifyUrl("localhost");
    expect(result.kind).toBe("navigate");
    expect(result.url).toBe("http://localhost");
  });

  it("adds http:// for localhost with path", () => {
    const result = classifyUrl("localhost/app");
    expect(result.kind).toBe("navigate");
    expect(result.url).toBe("http://localhost/app");
  });

  it("adds http:// for localhost with port", () => {
    const result = classifyUrl("localhost:3000");
    expect(result.kind).toBe("navigate");
    expect(result.url).toBe("http://localhost:3000");
  });
});

// ---------------------------------------------------------------------------
// 4. 127.0.0.1
// ---------------------------------------------------------------------------

describe("classifyUrl — 127.0.0.1", () => {
  it("adds http:// for 127.0.0.1", () => {
    const result = classifyUrl("127.0.0.1");
    expect(result.kind).toBe("navigate");
    expect(result.url).toBe("http://127.0.0.1");
  });

  it("adds http:// for 127.0.0.1 with port", () => {
    const result = classifyUrl("127.0.0.1:8080");
    expect(result.kind).toBe("navigate");
    expect(result.url).toBe("http://127.0.0.1:8080");
  });
});

// ---------------------------------------------------------------------------
// 5. Raw IPv4
// ---------------------------------------------------------------------------

describe("classifyUrl — raw IPv4", () => {
  it("adds http:// for 192.168.1.1", () => {
    const result = classifyUrl("192.168.1.1");
    expect(result.kind).toBe("navigate");
    expect(result.url).toBe("http://192.168.1.1");
  });

  it("adds http:// for 10.0.0.1:4000", () => {
    const result = classifyUrl("10.0.0.1:4000");
    expect(result.kind).toBe("navigate");
    expect(result.url).toBe("http://10.0.0.1:4000");
  });
});

// ---------------------------------------------------------------------------
// 6. example.com (simple domain)
// ---------------------------------------------------------------------------

describe("classifyUrl — simple domain", () => {
  it("adds https:// for example.com", () => {
    const result = classifyUrl("example.com");
    expect(result.kind).toBe("navigate");
    expect(result.url).toBe("https://example.com");
  });

  it("adds https:// for example.com/path", () => {
    const result = classifyUrl("example.com/path");
    expect(result.kind).toBe("navigate");
    expect(result.url).toBe("https://example.com/path");
  });
});

// ---------------------------------------------------------------------------
// 7. sub.example.co.kr (multi-level TLD)
// ---------------------------------------------------------------------------

describe("classifyUrl — multi-level TLD", () => {
  it("adds https:// for sub.example.co.kr", () => {
    const result = classifyUrl("sub.example.co.kr");
    expect(result.kind).toBe("navigate");
    expect(result.url).toBe("https://sub.example.co.kr");
  });

  it("adds https:// for api.service.io with path", () => {
    const result = classifyUrl("api.service.io/v2/items");
    expect(result.kind).toBe("navigate");
    expect(result.url).toBe("https://api.service.io/v2/items");
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
  it("navigates as-is for file:///Users/x/notes.html", () => {
    const result = classifyUrl("file:///Users/x/notes.html");
    expect(result.kind).toBe("navigate");
    expect(result.url).toBe("file:///Users/x/notes.html");
  });

  it("navigates as-is for file://localhost/path", () => {
    const result = classifyUrl("file://localhost/path");
    expect(result.kind).toBe("navigate");
    expect(result.url).toBe("file://localhost/path");
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
  it("prepends file:// to a Unix-style absolute path", () => {
    const result = classifyUrl("/Users/kih/workspaces/notes.html");
    expect(result.kind).toBe("navigate");
    expect(result.url).toBe("file:///Users/kih/workspaces/notes.html");
  });

  it("handles paths with no file extension", () => {
    const result = classifyUrl("/etc/hosts");
    expect(result.kind).toBe("navigate");
    expect(result.url).toBe("file:///etc/hosts");
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
// 10. javascript: scheme — blocked
// ---------------------------------------------------------------------------

describe("classifyUrl — javascript: scheme (blocked)", () => {
  it("blocks javascript:alert(1)", () => {
    const result = classifyUrl("javascript:alert(1)");
    expect(result.kind).toBe("blocked");
    expect(result.error).toBeDefined();
    expect(result.error).toContain("javascript");
  });

  it("blocks javascript: with mixed case", () => {
    const result = classifyUrl("JavaScript:void(0)");
    expect(result.kind).toBe("blocked");
  });
});

// ---------------------------------------------------------------------------
// 11. data: scheme — blocked
// ---------------------------------------------------------------------------

describe("classifyUrl — data: scheme (blocked)", () => {
  it("blocks data:text/html,<h1>test</h1>", () => {
    const result = classifyUrl("data:text/html,<h1>test</h1>");
    expect(result.kind).toBe("blocked");
    expect(result.error).toBeDefined();
    expect(result.error).toContain("data");
  });
});

// ---------------------------------------------------------------------------
// 12. about: scheme — blocked
// ---------------------------------------------------------------------------

describe("classifyUrl — about: scheme (blocked)", () => {
  it("blocks about:blank", () => {
    const result = classifyUrl("about:blank");
    expect(result.kind).toBe("blocked");
    expect(result.error).toBeDefined();
    expect(result.error).toContain("about");
  });

  it("blocks about:newtab", () => {
    const result = classifyUrl("about:newtab");
    expect(result.kind).toBe("blocked");
  });
});
