/**
 * URL classifier for the browser tab URL bar.
 *
 * Classifies raw user input into one of three kinds:
 *   - "navigate"  → resolved URL ready to send to browser.navigate IPC
 *   - "search"    → Google search URL for the input query
 *   - "blocked"   → dangerous scheme that must not be loaded
 *
 * Classification is a pure function with no side-effects — suitable for direct
 * unit testing without any renderer context.
 *
 * PRIORITY ORDER (evaluated top-down, first match wins):
 *   1. Blocked schemes (javascript:, data:, about:)              → blocked
 *   2. Explicit http://, https://, or file:// scheme             → navigate (as-is)
 *   3. Absolute file path (`/...`)                               → navigate (file://)
 *   4. localhost / 127.0.0.1 / IPv4 with optional port           → navigate (http://)
 *   5. No-space string with dot + TLD-like suffix
 *      AND no slash before the first dot                         → navigate (https://)
 *   6. Anything else                                             → search
 *
 * file: is in the allowed set (alongside http/https) so users can open
 * local HTML / documents from disk.  See navigation-allowlist.ts for the
 * security rationale and constraints (webSecurity + sandbox still apply).
 *
 * THE SLASH-BEFORE-DOT GUARD (rule 5)
 * Without this guard, a partial file path like `Users/kih/notes.html` gets
 * mistaken for a domain because `.html` matches the 2-6-letter TLD pattern,
 * and we'd auto-prefix it with `https://` → `https://users/kih/notes.html`
 * → ERR_NAME_NOT_RESOLVED.  The guard distinguishes:
 *   `example.com/foo.html`  — dot before slash → real domain.
 *   `Users/kih/notes.html`  — slash before dot → path-like, NOT a domain.
 *                              Falls through to search rather than navigate.
 * The user's expected path-form (`/Users/...`) is handled by rule 3 above.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type UrlClassifierKind = "navigate" | "search" | "blocked";

export interface UrlClassifierResult {
  kind: UrlClassifierKind;
  /** The resolved URL (navigate/search) or the original input (blocked). */
  url: string;
  /** Human-readable error message, present only for "blocked" kind. */
  error?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Schemes that must never be loaded in the embedded browser. */
const BLOCKED_SCHEME_RE = /^(about:|javascript:|data:)/i;

/**
 * Explicit http/https/file scheme — navigate as-is.
 *
 * file:// is allowed so users can open local HTML / documents.  The
 * `//` is required in the regex to avoid matching arbitrary `xxx:` text
 * that happens to start with the same letters.
 */
const EXPLICIT_HTTP_RE = /^(https?|file):\/\//i;

/** localhost, 127.0.0.1, or any IPv4 address (with optional port). */
const LOCAL_ADDRESS_RE =
  /^(localhost|127\.0\.0\.1|(?:\d{1,3}\.){3}\d{1,3})(:\d+)?(\/.*)?$/i;

/**
 * Simple domain-like heuristic: no spaces, contains at least one dot, and the
 * last segment looks like a TLD (2–6 ASCII letters) — e.g. "example.com",
 * "sub.example.co.kr", "localhost.dev".
 *
 * Intentionally loose: we'd rather navigate a borderline input than search it.
 */
const DOMAIN_LIKE_RE = /^[^\s]+\.[a-zA-Z]{2,6}(:\d+)?(\/.*)?$/;

// ---------------------------------------------------------------------------
// Classifier
// ---------------------------------------------------------------------------

/**
 * Classify raw URL bar input into a navigator action.
 *
 * @param raw - The raw text from the URL bar (trimmed before classifying).
 */
export function classifyUrl(raw: string): UrlClassifierResult {
  const input = raw.trim();

  if (!input) {
    return { kind: "search", url: "https://www.google.com/search?q=" };
  }

  // 1. Blocked schemes
  if (BLOCKED_SCHEME_RE.test(input)) {
    const scheme = input.split(":")[0]?.toLowerCase() ?? input;
    return {
      kind: "blocked",
      url: input,
      error: `"${scheme}:" URLs are not allowed in the browser tab.`,
    };
  }

  // 2. Explicit http://, https://, or file:// scheme
  if (EXPLICIT_HTTP_RE.test(input)) {
    return { kind: "navigate", url: input };
  }

  // 3. Absolute file path (`/Users/foo`, `/home/me/x.html`).
  //    The user explicitly opted into file:// support; an unambiguous
  //    leading slash is the safest auto-prefix because no remote URL form
  //    starts with `/`.
  if (input.startsWith("/")) {
    return { kind: "navigate", url: `file://${input}` };
  }

  // 4. Local address (localhost / 127.0.0.1 / raw IPv4)
  if (LOCAL_ADDRESS_RE.test(input)) {
    return { kind: "navigate", url: `http://${input}` };
  }

  // 5. Domain-like string (has a dot, no spaces, TLD-like suffix).
  //
  //    Slash-before-dot guard: an input like `Users/kih/notes.html` matches
  //    DOMAIN_LIKE_RE because `.html` looks like a 2-6 letter TLD, but it
  //    is clearly a relative file path — the slash appears BEFORE the
  //    first dot.  Real domains have the dot in the host (which precedes
  //    any path slash): `example.com/foo.html`.  Fall through to search
  //    when the slash comes first; users wanting a local file should
  //    write the leading `/` (rule 3) or the full `file://` scheme (rule 2).
  if (DOMAIN_LIKE_RE.test(input)) {
    const slashIdx = input.indexOf("/");
    const dotIdx = input.indexOf(".");
    if (slashIdx === -1 || dotIdx < slashIdx) {
      return { kind: "navigate", url: `https://${input}` };
    }
    // slash precedes the first dot → path-like, fall through.
  }

  // 6. Fallback: Google search
  return {
    kind: "search",
    url: `https://www.google.com/search?q=${encodeURIComponent(input)}`,
  };
}
