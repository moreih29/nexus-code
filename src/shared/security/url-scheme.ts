/**
 * URL scheme allowlist guard for external navigation.
 *
 * WHY ALLOWLIST
 * shell.openExternal passes the URL directly to the OS default handler.
 * That makes it an OS handler trampoline: a `javascript:` URI executes in
 * whatever context the OS chooses, `file:` exposes the local filesystem,
 * and app-protocol schemes (`vscode:`, `cursor:`) can silently trigger
 * privileged operations in third-party applications.  An explicit allowlist
 * of safe, network-only schemes (http, https, mailto) prevents those vectors
 * without blocking legitimate external links.
 */

/** The schemes that are safe to pass to shell.openExternal. */
export const EXTERNAL_SCHEME_ALLOWLIST = ["http:", "https:", "mailto:"] as const;

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
export function isExternalSchemeAllowed(rawUrl: string): boolean {
  if (!rawUrl) return false;

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }

  return (EXTERNAL_SCHEME_ALLOWLIST as readonly string[]).includes(parsed.protocol);
}
