/**
 * Unit tests for the in-frame navigation scheme allowlist guard.
 *
 * Covers allowed schemes, blocked schemes, and edge-case inputs that exercise
 * URL parsing robustness.  Each case documents the security intent alongside
 * the assertion so the expected behaviour is unambiguous.
 */

import { describe, expect, test } from "bun:test";
import {
  CHROMIUM_PDF_VIEWER_EXTENSION_ID,
  isBuiltinPdfViewerUrl,
  isNavigationSchemeAllowed,
  isSubframeNavigationAllowed,
} from "../../../../src/shared/security/navigation-allowlist";

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

  test("permits file:// URIs (local HTML / documents)", () => {
    // User-opt-in scheme.  webSecurity + sandbox still constrain
    // cross-origin reads even though the scheme passes the allowlist.
    expect(isNavigationSchemeAllowed("file:///Users/x/notes.html")).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Blocked schemes — must return false
  // -------------------------------------------------------------------------

  test("blocks mailto: URIs (OS mail handler, not in-frame content)", () => {
    expect(isNavigationSchemeAllowed("mailto:foo@bar.com")).toBe(false);
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

  test("does NOT permit the built-in PDF viewer extension via the scheme allowlist", () => {
    // chrome-extension: is not in the scheme allowlist; the PDF viewer frame is
    // permitted by the dedicated isBuiltinPdfViewerUrl() exemption instead.
    expect(
      isNavigationSchemeAllowed(`chrome-extension://${CHROMIUM_PDF_VIEWER_EXTENSION_ID}/abc`),
    ).toBe(false);
  });
});

describe("isBuiltinPdfViewerUrl", () => {
  test("matches Chromium's built-in PDF viewer sub-frame URL", () => {
    // Electron 41 renders inline PDFs in a sub-frame at this origin; the
    // navigation guard must let it through or the page area renders blank.
    expect(
      isBuiltinPdfViewerUrl(
        `chrome-extension://${CHROMIUM_PDF_VIEWER_EXTENSION_ID}/b0f3c59b-1673-4ef0-a69d-008a3a328639`,
      ),
    ).toBe(true);
  });

  test("matches the viewer origin with no path", () => {
    expect(isBuiltinPdfViewerUrl(`chrome-extension://${CHROMIUM_PDF_VIEWER_EXTENSION_ID}`)).toBe(
      true,
    );
  });

  test("rejects a DIFFERENT chrome-extension id (only the fixed PDF viewer is allowed)", () => {
    expect(isBuiltinPdfViewerUrl("chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/x")).toBe(
      false,
    );
  });

  test("rejects http/https/file URLs", () => {
    expect(isBuiltinPdfViewerUrl("https://example.com")).toBe(false);
    expect(isBuiltinPdfViewerUrl("file:///tmp/x.pdf")).toBe(false);
  });

  test("rejects empty and malformed input", () => {
    expect(isBuiltinPdfViewerUrl("")).toBe(false);
    expect(isBuiltinPdfViewerUrl("not a url")).toBe(false);
  });
});

describe("isSubframeNavigationAllowed", () => {
  // Superset of the top-level allowlist.
  test("permits everything the top-level allowlist permits", () => {
    expect(isSubframeNavigationAllowed("https://example.com")).toBe(true);
    expect(isSubframeNavigationAllowed("http://example.com")).toBe(true);
    expect(isSubframeNavigationAllowed("file:///x.html")).toBe(true);
  });

  test("ADDITIONALLY permits data: in sub-frames (blocked at top-level)", () => {
    expect(isSubframeNavigationAllowed("data:text/html,<h1>hi</h1>")).toBe(true);
    expect(isNavigationSchemeAllowed("data:text/html,<h1>hi</h1>")).toBe(false);
  });

  test("ADDITIONALLY permits blob: in sub-frames (blocked at top-level)", () => {
    expect(isSubframeNavigationAllowed("blob:https://example.com/uuid")).toBe(true);
    expect(isNavigationSchemeAllowed("blob:https://example.com/uuid")).toBe(false);
  });

  test("still blocks javascript: in sub-frames (code execution)", () => {
    expect(isSubframeNavigationAllowed("javascript:alert(1)")).toBe(false);
  });

  test("still blocks mailto: / other schemes in sub-frames", () => {
    expect(isSubframeNavigationAllowed("mailto:a@b.com")).toBe(false);
  });

  test("rejects empty / malformed input", () => {
    expect(isSubframeNavigationAllowed("")).toBe(false);
    expect(isSubframeNavigationAllowed("::nope")).toBe(false);
  });
});
