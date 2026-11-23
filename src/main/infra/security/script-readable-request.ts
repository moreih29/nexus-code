import path from "node:path";

const MODULE_SCRIPT_EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".css"]);

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
