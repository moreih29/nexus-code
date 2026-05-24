/**
 * Unit tests for the in-frame navigation scheme allowlist guard.
 *
 * Covers allowed schemes, blocked schemes, and edge-case inputs that exercise
 * URL parsing robustness.  Each case documents the security intent alongside
 * the assertion so the expected behaviour is unambiguous.
 */

import { describe, expect, test } from "bun:test";
import { isNavigationSchemeAllowed } from "../../../../src/shared/security/navigation-allowlist";

describe("isNavigationSchemeAllowed", () => {
  // -------------------------------------------------------------------------
  // Allowed schemes — must return true
  // -------------------------------------------------------------------------

  test("permits http:// URLs", () => {
    expect(isNavigationSchemeAllowed("http://example.com")).toBe(true);
  });

  test("permits https:// URLs with path and query", () => {
    expect(isNavigationSchemeAllowed("https://example.com/path?q=1")).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Blocked schemes — must return false
  // -------------------------------------------------------------------------

  test("blocks mailto: URIs (OS mail handler, not in-frame content)", () => {
    expect(isNavigationSchemeAllowed("mailto:foo@bar.com")).toBe(false);
  });

  test("blocks file: URIs (local filesystem exposure)", () => {
    expect(isNavigationSchemeAllowed("file:///etc/passwd")).toBe(false);
  });

  test("blocks javascript: URIs (code execution in renderer)", () => {
    expect(isNavigationSchemeAllowed("javascript:alert(1)")).toBe(false);
  });

  test("blocks data: URIs (HTML injection vector)", () => {
    expect(isNavigationSchemeAllowed("data:text/html,...")).toBe(false);
  });

  test("blocks about: URIs (internal browser pages)", () => {
    expect(isNavigationSchemeAllowed("about:blank")).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Edge cases — malformed / empty inputs
  // -------------------------------------------------------------------------

  test("returns false for empty string", () => {
    expect(isNavigationSchemeAllowed("")).toBe(false);
  });

  test("returns false for non-URL string", () => {
    expect(isNavigationSchemeAllowed("not a url")).toBe(false);
  });

  test("returns false for broken authority string", () => {
    // '://broken' has no scheme — URL constructor throws
    expect(isNavigationSchemeAllowed("://broken")).toBe(false);
  });

  test("permits HTTP:// with uppercase scheme (URL.protocol normalises to lowercase)", () => {
    // The URL constructor lowercases the protocol, so 'HTTP:' → 'http:'
    // and it correctly matches the allowlist without extra case handling.
    expect(isNavigationSchemeAllowed("HTTP://example.com")).toBe(true);
  });

  test("permits Https:// with mixed-case scheme", () => {
    expect(isNavigationSchemeAllowed("Https://example.com")).toBe(true);
  });
});
