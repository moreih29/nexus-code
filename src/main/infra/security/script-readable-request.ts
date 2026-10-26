import path from "node:path";

// ---------------------------------------------------------------------------
// Local files reachable from page script — workspace files over
// nexus-workspace:// (HTML preview) and the disk over file:// (pages opened in
// the embedded browser). Electron enforces CORS on neither: `corsEnabled`
// lets CORS-mode loads of the custom scheme through regardless of
// Access-Control-Allow-Origin, and file:// pages get extra privileges by
// default, so a page script can read `.env`, `.git/config` or `~/.ssh` and
// send it elsewhere. Requests are filtered by type instead: subresources a
// page renders with (images, fonts, styles, frames, JS/CSS module scripts)
// load; script-readable fetches (XHR/fetch, JSON modules) are cancelled —
// what Chrome allows a page opened from file://.
// ---------------------------------------------------------------------------

const MODULE_SCRIPT_EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".css"]);

/**
 * Whether a webRequest of `resourceType` for `url` would let page script read
 * the file's bytes. fetch() arrives as "xhr"; JSON modules arrive as "script".
 */
export function isScriptReadableRequest(resourceType: string, url: string): boolean {
  if (resourceType === "xhr") return true;
  if (resourceType === "script") {
    let pathname: string;
    try {
      pathname = new URL(url).pathname;
    } catch {
      return true;
    }
    return !MODULE_SCRIPT_EXTENSIONS.has(path.posix.extname(pathname).toLowerCase());
  }
  return false;
}
