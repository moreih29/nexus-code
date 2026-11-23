import { describe, expect, test } from "bun:test";
import { isExternalSchemeAllowed } from "../../../../src/shared/security/url-scheme";

describe("isExternalSchemeAllowed", () => {
  test("permits http:// URLs", () => {
    expect(isExternalSchemeAllowed("http://example.com")).toBe(true);
  });

  test("permits https:// URLs with path and query", () => {
    expect(isExternalSchemeAllowed("https://example.com/path?q=1")).toBe(true);
  });

  test("permits mailto: URIs", () => {
    expect(isExternalSchemeAllowed("mailto:foo@bar.com")).toBe(true);
  });

  test("blocks file: URIs (local filesystem exposure)", () => {
    expect(isExternalSchemeAllowed("file:///etc/passwd")).toBe(false);
  });

  test("blocks vscode: app-protocol URIs", () => {
    expect(isExternalSchemeAllowed("vscode://open")).toBe(false);
  });

  test("blocks cursor: app-protocol URIs", () => {
    expect(isExternalSchemeAllowed("cursor://open")).toBe(false);
  });

  test("blocks javascript: URIs (code execution trampoline)", () => {
    expect(isExternalSchemeAllowed("javascript:alert(1)")).toBe(false);
  });

  test("blocks data: URIs (HTML injection vector)", () => {
    expect(isExternalSchemeAllowed("data:text/html,...")).toBe(false);
  });

  test("blocks ftp: URIs (not in allowlist)", () => {
    expect(isExternalSchemeAllowed("ftp://example.com")).toBe(false);
  });

  test("blocks chrome: internal browser URIs", () => {
    expect(isExternalSchemeAllowed("chrome://")).toBe(false);
  });

  test("returns false for empty string", () => {
    expect(isExternalSchemeAllowed("")).toBe(false);
  });

  test("returns false for non-URL string", () => {
    expect(isExternalSchemeAllowed("not a url")).toBe(false);
  });

  test("returns false for broken authority string", () => {
    expect(isExternalSchemeAllowed("://broken")).toBe(false);
  });

  test("permits HTTPS:// with uppercase scheme (URL.protocol normalises to lowercase)", () => {
    expect(isExternalSchemeAllowed("HTTPS://OK")).toBe(true);
  });
});
