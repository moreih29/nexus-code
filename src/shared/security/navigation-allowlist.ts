/**
 * URL scheme allowlist guard for in-frame browser navigation.
 *
 * WHY SEPARATE MODULE
 * shell.openExternal (url-scheme.ts) hands the URL off to the OS default
 * handler, so mailto: is legitimate there — it opens the mail client.
 * In-frame navigation loads the URL inside the embedded browser, so only
 * direct-load schemes make sense.  Keeping the two allowlists separate
 * prevents the OS-handler semantics from leaking into the renderer context
 * and makes each policy independently auditable.
 *
 * WHY ALLOWLIST
 * `javascript:` executes arbitrary code in the renderer process — it MUST
 * remain blocked everywhere. `http`/`https`/`file` are the safe top-level
 * navigation schemes. The browser tab's WebContents still ships with
 * `webSecurity: true` and `sandbox: true`, so even the schemes we allow obey
 * same-origin and sandbox policies (e.g. one `file://` document cannot
 * cross-fetch another `file://` document outside its directory).
 *
 * file: is included so users can open local HTML / documents (the user
 * explicitly opted in to this).  Cross-origin reads from file: documents
 * stay constrained by Chromium's `webSecurity` even with this entry.
 *
 * TOP-LEVEL vs SUB-FRAME
 * `data:` and `blob:` are permitted in SUB-FRAMES only (see
 * `SUBFRAME_SCHEME_ALLOWLIST` / `isSubframeNavigationAllowed`) — legitimate
 * sites embed them (generated previews, blob media, embedded viewers) and in a
 * sub-frame they get an opaque origin that cannot read the parent under
 * `webSecurity`. They stay BLOCKED at top-level, where a `data:` document is a
 * phishing / address-bar-spoofing vector — matching Chrome, which also
 * restricts top-level `data:` navigation.
 */

/** The schemes that are safe to navigate to at the TOP LEVEL of a browser tab. */
export const NAVIGATION_SCHEME_ALLOWLIST = ["http:", "https:", "file:"] as const;

/**
 * Extra schemes permitted ONLY in sub-frames (never top-level navigation).
 *
 * `data:`/`blob:` sub-frames are common on real sites and are constrained by
 * `webSecurity` + `sandbox` (opaque origin, cannot read the embedding page).
 * `javascript:` is intentionally absent — it executes code in the renderer and
 * must never be allowed in any frame.
 */
export const SUBFRAME_SCHEME_ALLOWLIST = ["data:", "blob:"] as const;

/**
 * Returns true when `rawUrl` parses to one of the allowed schemes.
 *
 * The built-in `URL` constructor is used for parsing because it normalises
 * the protocol to lowercase (e.g. "HTTPS:" → "https:"), which makes the
 * comparison case-insensitive without extra string manipulation.
 *
 * Returns false for any input that is empty, unparseable, or whose scheme
 * is not in the allowlist.
 */
export function isNavigationSchemeAllowed(rawUrl: string): boolean {
  if (!rawUrl) return false;

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }

  return (NAVIGATION_SCHEME_ALLOWLIST as readonly string[]).includes(parsed.protocol);
}

/**
 * Returns true when `rawUrl` is allowed to load in a SUB-FRAME.
 *
 * Superset of `isNavigationSchemeAllowed`: everything valid at top-level, plus
 * the sub-frame-only schemes in `SUBFRAME_SCHEME_ALLOWLIST` (`data:`/`blob:`).
 * Use this for `will-frame-navigate`; use `isNavigationSchemeAllowed` for
 * top-level `will-navigate`.
 */
export function isSubframeNavigationAllowed(rawUrl: string): boolean {
  if (isNavigationSchemeAllowed(rawUrl)) return true;
  if (!rawUrl) return false;

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }

  return (SUBFRAME_SCHEME_ALLOWLIST as readonly string[]).includes(parsed.protocol);
}

/**
 * The fixed extension id of Chromium's built-in PDF viewer.
 *
 * This is NOT a user-installable extension — it is baked into Chromium and the
 * id is stable across versions. Electron does not load arbitrary extensions
 * into browser-tab WebContents, so this id is the only `chrome-extension:`
 * origin we ever expect to see in an embedded tab.
 */
export const CHROMIUM_PDF_VIEWER_EXTENSION_ID = "mhjfbmdgcfjbbpaeojofohoefgiehjai";

/**
 * Returns true when `rawUrl` is served by Chromium's built-in PDF viewer.
 *
 * WHY THIS EXISTS
 * Since Electron 41 the PDF viewer renders the document in an out-of-process
 * sub-frame navigated to `chrome-extension://<PDF_VIEWER_ID>/<uuid>`. That
 * scheme is not in `NAVIGATION_SCHEME_ALLOWLIST`, so the `will-frame-navigate`
 * guard would block it — leaving the viewer's toolbar visible but the page
 * area blank (verified empirically on Electron 41). The guard whitelists this
 * exact origin so native PDF rendering works without widening the general
 * scheme allowlist to all `chrome-extension:` URLs.
 *
 * Matches on protocol + hostname rather than `URL.origin`: for the
 * non-special `chrome-extension:` scheme Node's `URL.origin` serialises to the
 * opaque string "null", so an origin comparison would never match.
 */
export function isBuiltinPdfViewerUrl(rawUrl: string): boolean {
  if (!rawUrl) return false;

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }

  return (
    parsed.protocol === "chrome-extension:" && parsed.hostname === CHROMIUM_PDF_VIEWER_EXTENSION_ID
  );
}
