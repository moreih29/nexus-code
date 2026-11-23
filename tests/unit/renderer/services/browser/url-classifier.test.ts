import { describe, expect, it, test } from "bun:test";
import { classifyUrl } from "../../../../../src/renderer/services/browser/url-classifier";

describe("classifyUrl — explicit scheme (navigate as-is)", () => {
  test.each([
    ["http://example.com", "http://example.com"],
    ["http://example.com/path?q=1", "http://example.com/path?q=1"],
    ["https://example.com", "https://example.com"],
    ["https://example.com/page#section", "https://example.com/page#section"],
  ] as const)("%s → navigate %s", (input, expectedUrl) => {
    const result = classifyUrl(input);
    expect(result.kind).toBe("navigate");
    expect(result.url).toBe(expectedUrl);
  });
});

describe("classifyUrl — local addresses (http:// prefix)", () => {
  test.each([
    ["localhost", "http://localhost"],
    ["localhost/app", "http://localhost/app"],
    ["localhost:3000", "http://localhost:3000"],
    ["127.0.0.1", "http://127.0.0.1"],
    ["127.0.0.1:8080", "http://127.0.0.1:8080"],
    ["192.168.1.1", "http://192.168.1.1"],
    ["10.0.0.1:4000", "http://10.0.0.1:4000"],
  ] as const)("%s → navigate %s", (input, expectedUrl) => {
    const result = classifyUrl(input);
    expect(result.kind).toBe("navigate");
    expect(result.url).toBe(expectedUrl);
  });
});

describe("classifyUrl — domain names (https:// prefix)", () => {
  test.each([
    ["example.com", "https://example.com"],
    ["example.com/path", "https://example.com/path"],
    ["sub.example.co.kr", "https://sub.example.co.kr"],
    ["api.service.io/v2/items", "https://api.service.io/v2/items"],
  ] as const)("%s → navigate %s", (input, expectedUrl) => {
    const result = classifyUrl(input);
    expect(result.kind).toBe("navigate");
    expect(result.url).toBe(expectedUrl);
  });
});

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

describe("classifyUrl — file:// scheme (navigate)", () => {
  test.each([
    ["file:///Users/x/notes.html", "file:///Users/x/notes.html"],
    ["file://localhost/path", "file://localhost/path"],
  ] as const)("%s → navigate %s", (input, expectedUrl) => {
    const result = classifyUrl(input);
    expect(result.kind).toBe("navigate");
    expect(result.url).toBe(expectedUrl);
  });
});

describe("classifyUrl — absolute file path (auto-prefix file://)", () => {
  test.each([
    ["/Users/kih/workspaces/notes.html", "file:///Users/kih/workspaces/notes.html"],
    ["/etc/hosts", "file:///etc/hosts"],
  ] as const)("%s → navigate %s", (input, expectedUrl) => {
    const result = classifyUrl(input);
    expect(result.kind).toBe("navigate");
    expect(result.url).toBe(expectedUrl);
  });
});

describe("classifyUrl — path-like input without leading slash (search fallback)", () => {
  it("does not auto-prefix https:// when the slash precedes the dot", () => {
    const result = classifyUrl("Users/kih/foo.html");
    expect(result.kind).toBe("search");
    expect(result.url).not.toContain("//users/");
  });

  it("falls through to search for path-like input ending in another extension", () => {
    const result = classifyUrl("documents/report.pdf");
    expect(result.kind).toBe("search");
  });

  it("still navigates https:// for a real domain followed by a slash-path", () => {
    const result = classifyUrl("example.com/foo.html");
    expect(result.kind).toBe("navigate");
    expect(result.url).toBe("https://example.com/foo.html");
  });
});

describe("classifyUrl — blocked schemes", () => {
  test.each([
    ["javascript:alert(1)", "javascript"],
    ["data:text/html,<h1>test</h1>", "data"],
    ["about:blank", "about"],
  ] as const)("%s → blocked (error contains '%s')", (input, schemeWord) => {
    const result = classifyUrl(input);
    expect(result.kind).toBe("blocked");
    expect(result.error).toBeDefined();
    expect(result.error).toContain(schemeWord);
  });

  test.each([
    ["JavaScript:void(0)", "javascript: mixed case"],
    ["about:newtab", "about: alternate page"],
  ] as const)("%s → blocked (%s)", (input) => {
    const result = classifyUrl(input);
    expect(result.kind).toBe("blocked");
  });
});
