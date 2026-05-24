/**
 * URL scheme allowlist guard for in-frame browser navigation.
 *
 * WHY SEPARATE MODULE
 * shell.openExternal (url-scheme.ts) hands the URL off to the OS default
 * handler, so mailto: is legitimate there — it opens the mail client.
 * In-frame navigation loads the URL inside the embedded browser, so only
 * network-fetch schemes make sense.  Keeping the two allowlists separate
 * prevents the OS-handler semantics from leaking into the renderer context
 * and makes each policy independently auditable.
 *
 * WHY ALLOWLIST
 * javascript: executes arbitrary code in the renderer process,
 * data:/about:/blob: can inject arbitrary HTML, and file: exposes the
 * local filesystem.  An allowlist of http/https is the minimal-privilege
 * policy that still covers every real-world web navigation target.
 */

/** The schemes that are safe to navigate to inside an in-frame browser tab. */
export const NAVIGATION_SCHEME_ALLOWLIST = ["http:", "https:"] as const;

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
