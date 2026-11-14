import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Session } from "electron";
import { createLogger } from "../../../shared/log/main";
import { PREVIEW_SCHEME } from "../../../shared/preview/document-url";

// ---------------------------------------------------------------------------
// The app window's Content-Security-Policy.
//
// The renderer holds the preload's IPC, terminal spawning included, and draws
// content it did not write: markdown with raw HTML, mermaid, docx-preview,
// pdf.js, Excalidraw, agents' output. Each has its own sanitizer; the policy
// is the wall behind them. Should one let markup through, it still runs no
// script but the app's own files, embeds nothing but the app's preview frames,
// and loads nothing from the network but images.
//
// Main sends it as a response header with the app's page (file:// in a build,
// the Vite dev server in dev), not as a <meta>: a header also works in
// Report-Only, and applies before a byte of the page is parsed.
//
// Previewed workspace HTML is not under it: the preview serves its pages from
// nexus-preview:// with a policy of its own (custom-protocols/nexus-preview.ts),
// and a page from a scheme of its own does not take on the window's.
// ---------------------------------------------------------------------------

const logger = createLogger("app-csp");

/** The directives every build's policy has. */
const BASE_DIRECTIVES: Readonly<Record<string, readonly string[]>> = {
  "default-src": ["'self'"],
  // Only the app's own files. WebAssembly (the TextMate grammars' oniguruma)
  // compiles with 'wasm-unsafe-eval', which runs no text as code.
  "script-src": ["'self'", "'wasm-unsafe-eval'"],
  // Monaco, xterm, Excalidraw, mermaid and docx-preview put <style> elements
  // and style attributes in the page.
  "style-src": ["'self'", "'unsafe-inline'"],
  // Images of markdown and chat may be anywhere on the web; pasted and drawn
  // ones are data: and blob:; a workspace's come over nexus-workspace://.
  "img-src": ["'self'", "data:", "blob:", "nexus-workspace:", "https:", "http:"],
  // No CDN: Excalidraw's fonts ship with the app (notes/editor/
  // excalidraw-assets.ts), and the CDN it falls back to stays blocked.
  "font-src": ["'self'", "data:", "blob:", "nexus-workspace:"],
  "media-src": ["'self'", "data:", "blob:", "nexus-workspace:"],
  "connect-src": ["'self'", "data:", "blob:"],
  // Monaco and pdf.js run workers from the app's files; some libraries start
  // theirs from a blob.
  "worker-src": ["'self'", "blob:"],
  // The HTML preview's pages and the thumbnails of a chat's artifacts.
  "frame-src": [`${PREVIEW_SCHEME}:`, "nexus-workspace:"],
  "object-src": ["'none'"],
  "base-uri": ["'none'"],
  "form-action": ["'none'"],
  "frame-ancestors": ["'none'"],
};

/** What the Vite dev server needs on top: React Refresh's inline preamble, and HMR's socket. */
const DEV_DIRECTIVES: Readonly<Record<string, readonly string[]>> = {
  "script-src": ["'unsafe-inline'"],
  "connect-src": ["ws://localhost:*", "ws://127.0.0.1:*"],
};

/** The app window's policy, for a build served from `devServerUrl` or from its files. */
export function appContentSecurityPolicy(devServerUrl?: string): string {
  const directives = new Map<string, string[]>();
  for (const [name, sources] of Object.entries(BASE_DIRECTIVES)) directives.set(name, [...sources]);
  if (devServerUrl !== undefined) {
    for (const [name, sources] of Object.entries(DEV_DIRECTIVES)) {
      directives.get(name)?.push(...sources);
    }
  }
  return [...directives].map(([name, sources]) => `${name} ${sources.join(" ")}`).join("; ");
}

/** Where the app's page is served from: its file, or the dev server. */
export interface AppPage {
  /** The absolute path of the renderer's index.html in a build. */
  readonly indexPath: string;
  /** The dev server's address, when the window loads from it. */
  readonly devServerUrl?: string;
}

function samePath(a: string, b: string): boolean {
  const left = path.resolve(a);
  const right = path.resolve(b);
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

/** Whether `url` is the app's page, which the policy goes with. */
export function isAppPageUrl(url: string, page: AppPage): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (page.devServerUrl !== undefined) {
    try {
      return parsed.origin === new URL(page.devServerUrl).origin;
    } catch {
      return false;
    }
  }
  if (parsed.protocol !== "file:") return false;
  try {
    return samePath(fileURLToPath(parsed), page.indexPath);
  } catch {
    return false;
  }
}

/** The URL patterns the app's page falls under, for webRequest's filter. */
export function appPageUrlPatterns(page: AppPage): string[] {
  if (page.devServerUrl === undefined) return ["file:///*"];
  try {
    return [`${new URL(page.devServerUrl).origin}/*`];
  } catch {
    return [];
  }
}

/** The response header the policy goes in: enforced, or only reported. */
export function cspHeaderName(reportOnly: boolean): string {
  return reportOnly ? "Content-Security-Policy-Report-Only" : "Content-Security-Policy";
}

/**
 * Sends the app's policy with its page on `session`. `reportOnly` reports
 * what the policy would block in the console instead of blocking it.
 */
export function installAppCsp(session: Session, page: AppPage, reportOnly = false): void {
  const policy = appContentSecurityPolicy(page.devServerUrl);
  const header = cspHeaderName(reportOnly);
  if (reportOnly) logger.warn(`The app window's policy only reports: ${policy}`);
  session.webRequest.onHeadersReceived({ urls: appPageUrlPatterns(page) }, (details, callback) => {
    if (details.resourceType !== "mainFrame" || !isAppPageUrl(details.url, page)) {
      callback({});
      return;
    }
    const responseHeaders = { ...details.responseHeaders };
    // The page's own header, if a server sent one, gives way to the app's.
    for (const name of Object.keys(responseHeaders)) {
      if (name.toLowerCase().startsWith("content-security-policy")) delete responseHeaders[name];
    }
    responseHeaders[header] = [policy];
    callback({ responseHeaders });
  });
}
