import { describe, expect, test } from "bun:test";
import {
  CHROMIUM_PDF_VIEWER_EXTENSION_ID,
  isBuiltinPdfViewerUrl,
  isNavigationSchemeAllowed,
  isPopupNavigationAllowed,
  isSubframeNavigationAllowed,
  isTabLoadAllowed,
} from "../../../../src/shared/security/navigation-allowlist";

describe("isNavigationSchemeAllowed", () => {
  test("permits http:// URLs", () => {
    expect(isNavigationSchemeAllowed("http://example.com")).toBe(true);
  });

  test("permits https:// URLs with path and query", () => {
    expect(isNavigationSchemeAllowed("https://example.com/path?q=1")).toBe(true);
  });

  test("permits file:// URIs (local HTML / documents)", () => {
    expect(isNavigationSchemeAllowed("file:///Users/x/notes.html")).toBe(true);
  });

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

  test("returns false for empty string", () => {
    expect(isNavigationSchemeAllowed("")).toBe(false);
  });

  test("returns false for non-URL string", () => {
    expect(isNavigationSchemeAllowed("not a url")).toBe(false);
  });

  test("returns false for broken authority string", () => {
    expect(isNavigationSchemeAllowed("://broken")).toBe(false);
  });

  test("permits HTTP:// with uppercase scheme (URL.protocol normalises to lowercase)", () => {
    expect(isNavigationSchemeAllowed("HTTP://example.com")).toBe(true);
  });

  test("permits Https:// with mixed-case scheme", () => {
    expect(isNavigationSchemeAllowed("Https://example.com")).toBe(true);
  });

  test("does NOT permit the built-in PDF viewer extension via the scheme allowlist", () => {
    expect(
      isNavigationSchemeAllowed(`chrome-extension://${CHROMIUM_PDF_VIEWER_EXTENSION_ID}/abc`),
    ).toBe(false);
  });
});

describe("isBuiltinPdfViewerUrl", () => {
  test("matches Chromium's built-in PDF viewer sub-frame URL", () => {
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

describe("isPopupNavigationAllowed", () => {
  test("permits the web, never a local file its opener could read", () => {
    expect(isPopupNavigationAllowed("https://accounts.example.com/login")).toBe(true);
    expect(isPopupNavigationAllowed("http://localhost:3000")).toBe(true);
    expect(isPopupNavigationAllowed("file:///Users/x/.ssh/id_rsa")).toBe(false);
    expect(isPopupNavigationAllowed("javascript:alert(1)")).toBe(false);
    expect(isPopupNavigationAllowed("")).toBe(false);
  });
});

describe("isSubframeNavigationAllowed", () => {
  test("permits the web the top-level allowlist permits", () => {
    expect(isSubframeNavigationAllowed("https://example.com")).toBe(true);
    expect(isSubframeNavigationAllowed("http://example.com")).toBe(true);
  });

  test("blocks a local file: a file:// page could read the frame", () => {
    expect(isSubframeNavigationAllowed("file:///Users/x/.ssh/id_rsa")).toBe(false);
    expect(isSubframeNavigationAllowed("FILE:///x.html")).toBe(false);
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

describe("isTabLoadAllowed", () => {
  test("loads what a tab opens at the top level, and the blank page a new tab starts on", () => {
    expect(isTabLoadAllowed("https://example.com/")).toBe(true);
    expect(isTabLoadAllowed("http://localhost:3000/")).toBe(true);
    expect(isTabLoadAllowed("file:///tmp/report.html")).toBe(true);
    expect(isTabLoadAllowed("about:blank")).toBe(true);
  });

  test("does not load a script, a data page or the browser's own pages", () => {
    expect(isTabLoadAllowed("javascript:alert(document.cookie)")).toBe(false);
    expect(isTabLoadAllowed("data:text/html,<script>1</script>")).toBe(false);
    expect(isTabLoadAllowed("chrome://gpu")).toBe(false);
    expect(isTabLoadAllowed("devtools://devtools/bundled/inspector.html")).toBe(false);
    expect(isTabLoadAllowed("about:srcdoc")).toBe(false);
  });
});
