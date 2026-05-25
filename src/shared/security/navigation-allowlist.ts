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
 * `javascript:` executes arbitrary code in the renderer process and
 * `data:`/`blob:` can inject arbitrary HTML — these MUST remain blocked.
 * The browser tab's WebContents still ships with `webSecurity: true` and
 * `sandbox: true`, so even the schemes we allow obey same-origin and
 * sandbox policies (e.g. one `file://` document cannot cross-fetch
 * another `file://` document outside its directory).
 *
 * file: is included so users can open local HTML / documents (the user
 * explicitly opted in to this).  Cross-origin reads from file: documents
 * stay constrained by Chromium's `webSecurity` even with this entry.
 */

/** The schemes that are safe to navigate to inside an in-frame browser tab. */
export const NAVIGATION_SCHEME_ALLOWLIST = ["http:", "https:", "file:"] as const;

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
