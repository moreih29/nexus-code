/**
 * Browser tab security policy.
 *
 * This module centralises ALL security configuration for embedded browser
 * tabs (WebContentsView instances).  Three independent layers of defence are
 * applied to every new WebContents:
 *
 *   1. webPreferences — constructor-time hardening.
 *   2. Permission handler — deny-by-default, allow-list only.
 *   3. Navigation guards — will-navigate / will-frame-navigate /
 *      setWindowOpenHandler — block anything that is not http/https.
 *
 * CRITICAL: every guard must remain in place.  Removing any one of them
 * creates a code-execution or data-exfiltration vector.
 *
 *   - `javascript:` → executes arbitrary code in the renderer process.
 *   - `data:`/`blob:` → injects arbitrary HTML.
 *   - `file:` → reads the local filesystem.
 *   - New window (`window.open`) → escapes the partition sandbox unless
 *     intercepted and re-navigated inside the same tab.
 */

import type { WebContents, WebPreferences } from "electron";
import { createLogger } from "../../../shared/log/main";
import { isNavigationSchemeAllowed } from "../../../shared/security/navigation-allowlist";

const logger = createLogger("browser-security");

// ---------------------------------------------------------------------------
// webPreferences — the baseline constructor-time sandbox
// ---------------------------------------------------------------------------

/**
 * Returns the webPreferences object that MUST be used for every browser tab
 * WebContentsView.  These settings are constructor-only in Electron — they
 * cannot be changed after the WebContents is created.
 *
 * @param partition  Session partition string, e.g. `persist:browser-<workspaceId>`.
 *                   Passed through verbatim to Electron's session system.
 */
export function buildBrowserTabWebPreferences(partition: string): WebPreferences {
  return {
    partition,
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    webSecurity: true,
    // Prevent any preload script from being injected — browser tabs are
    // untrusted third-party web content and must not have access to Electron
    // or Node APIs under any circumstances.
    // (Intentionally no `preload` field.)
  };
}

// ---------------------------------------------------------------------------
// Permission request handler — deny everything except clipboard-sanitized-write
// ---------------------------------------------------------------------------

/**
 * The set of permissions that are allowed for browser tab content.
 *
 * clipboard-read is NOT in the list; only the sanitised write direction is
 * permitted to prevent clipboard sniffing by embedded pages.
 */
const ALLOWED_PERMISSIONS = new Set(["clipboard-sanitized-write"]);

/**
 * Installs a deny-by-default permission handler on the given session.
 *
 * This function is idempotent — calling it twice on the same session
 * replaces the previous handler (Electron's `setPermissionRequestHandler`
 * semantics).
 *
 * Denied permissions (non-exhaustive):
 *   media, geolocation, notifications, midi, midiSysex, pointerLock,
 *   fullscreen, openExternal, clipboard-read, display-capture
 */
export function installPermissionHandler(
  session: import("electron").Session,
): void {
  session.setPermissionRequestHandler((_webContents, permission, callback) => {
    const allowed = ALLOWED_PERMISSIONS.has(permission);
    if (!allowed) {
      logger.warn(`[permission] denied: ${permission}`);
    }
    callback(allowed);
  });
}

// ---------------------------------------------------------------------------
// Navigation guards — 3-layer defence on each WebContents instance
// ---------------------------------------------------------------------------

/**
 * The about:blank URL is a special case: it has no scheme in the traditional
 * sense and is used by Electron internally for initial frames.  We allow it
 * in will-frame-navigate to avoid breaking frame creation but block it in
 * will-navigate (top-level navigation) since it carries no useful content.
 */
const ABOUT_BLANK = "about:blank";

/**
 * Installs will-navigate, will-frame-navigate, and setWindowOpenHandler
 * guards on a WebContents instance.
 *
 * @param webContents  The WebContents to protect.
 * @param onNavigate   Called when a top-level navigation is allowed through
 *                     (used by the registry to keep the last-known URL in sync
 *                     and to drive `browser.navigated` broadcasts).
 */
export function installNavigationGuards(
  webContents: WebContents,
  onNavigate?: (url: string) => void,
): void {
  // Layer 1 — top-level navigation guard.
  // Covers: location.href assignments, <a target="_self"> clicks, and
  // programmatic webContents.loadURL calls that originate from the page.
  webContents.on("will-navigate", (event, url) => {
    if (!isNavigationSchemeAllowed(url)) {
      event.preventDefault();
      logger.warn(`[will-navigate] blocked: ${url}`);
      return;
    }
    onNavigate?.(url);
  });

  // Layer 2 — sub-frame navigation guard.
  // Covers: <iframe src="..."> changes and navigation inside embedded frames.
  // about:blank is allowed (Electron uses it for initial frame creation);
  // data: and blob: are blocked to prevent HTML injection.
  //
  // NOTE: `will-frame-navigate` is a real Electron runtime event introduced in
  // Electron 35 but may not be present in the bundled .d.ts for this version.
  // The `as unknown as NodeJS.EventEmitter` cast is intentional — the event
  // fires at runtime and the guard MUST remain for security.  Remove this cast
  // once the type definitions are updated to include the event signature.
  (webContents as unknown as NodeJS.EventEmitter).on(
    "will-frame-navigate",
    (
      event: { preventDefault(): void },
      details: { url: string; isMainFrame: boolean },
    ) => {
      const { url, isMainFrame } = details;

      // Main-frame navigations are already covered by will-navigate; only
      // apply the frame-specific logic here to avoid double-blocking.
      if (isMainFrame) return;

      if (url === ABOUT_BLANK) return; // allowed for frame initialisation

      if (!isNavigationSchemeAllowed(url)) {
        event.preventDefault();
        logger.warn(`[will-frame-navigate] blocked: ${url}`);
      }
    },
  );

  // Layer 3 — window.open / target="_blank" interception.
  // Policy (W2 decision from Plan 61):
  //   - http/https → navigate the same tab (no new window created).
  //   - Everything else → deny silently.
  webContents.setWindowOpenHandler(({ url }) => {
    if (isNavigationSchemeAllowed(url)) {
      // Redirect the navigation into the current WebContents instead of
      // opening a new window.  loadURL is deferred via setImmediate so that
      // the handler return value reaches Electron before the load starts.
      setImmediate(() => {
        if (!webContents.isDestroyed()) {
          webContents.loadURL(url).catch((err: Error) => {
            logger.warn(`[window-open] loadURL failed for ${url}: ${err.message}`);
          });
        }
      });
    } else {
      logger.warn(`[window-open] blocked: ${url}`);
    }
    // Always deny the popup window creation — either we load it ourselves
    // (http/https) or we block it entirely.
    return { action: "deny" };
  });
}
