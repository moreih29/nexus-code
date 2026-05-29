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
import { classifyPermission, isKnownPermission } from "../../../shared/security/browser-permissions";
import { isNavigationSchemeAllowed } from "../../../shared/security/navigation-allowlist";
import { resolvePermission } from "./permission-policy";
import type { BrowserPermissionPromptManager } from "./permission-prompt-manager";

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
// Permission request handler — classify, evaluate, and route to promptManager
// ---------------------------------------------------------------------------

/**
 * Dependencies injected into `installPermissionHandler`.
 *
 * Using a deps object keeps the function free of module-level singletons and
 * enables unit-testing without Electron mocks.
 */
export interface PermissionHandlerDeps {
  /**
   * Returns true when the workspace-level global permission toggle is ON for
   * `permission`.  Reads from AppState.browserPermissionGrants at call time.
   */
  getGlobalGrant(permission: string): boolean;
  /**
   * Returns the remembered per-(workspace, origin, permission) decision, or
   * null when no decision has been stored.
   */
  getRemembered(
    workspaceId: string,
    origin: string,
    permission: string,
  ): "allow" | "block" | null;
  /** Manages pending prompt lifecycles and coalescing. */
  promptManager: BrowserPermissionPromptManager;
}

/**
 * Classifies and resolves a permission request to allow / block / ask.
 *
 * - auto-classified permissions  → always 'allow'.
 * - blocked-classified or unknown → always 'block'.
 * - prompt-classified             → resolvePermission() with global+remembered.
 *
 * Exported so it can be unit-tested independently.
 */
export function evaluatePermission(
  workspaceId: string,
  origin: string,
  permission: string,
  deps: Pick<PermissionHandlerDeps, "getGlobalGrant" | "getRemembered">,
): "allow" | "block" | "ask" {
  const classification = classifyPermission(permission);

  if (classification === "auto") {
    return "allow";
  }

  if (classification === "blocked") {
    return "block";
  }

  // classification === 'prompt'
  // Invariant: classifyPermission returns 'prompt' only for known, non-'unknown'
  // permission strings, so isKnownPermission(permission) is always true here.
  // We pass it explicitly so resolvePermission's unknown-guard remains
  // self-contained and testable in isolation.
  return resolvePermission({
    globalAllowed: deps.getGlobalGrant(permission),
    remembered: deps.getRemembered(workspaceId, origin, permission),
    isKnownPermission: isKnownPermission(permission),
  });
}

/**
 * Installs a permission check handler and a permission request handler on the
 * given session.
 *
 * Both handlers share the same `evaluatePermission` logic so their answers are
 * always consistent.
 *
 * `setPermissionCheckHandler` — synchronous allow/deny for passive checks
 * (e.g. `navigator.permissions.query`).  Returns true only for 'allow'.
 *
 * `setPermissionRequestHandler` — async; routes 'ask' decisions through
 * `deps.promptManager` which broadcasts a UI prompt and waits for the user's
 * response.
 *
 * This function is idempotent — calling it twice on the same session replaces
 * the previous handlers (Electron semantics).
 *
 * `workspaceId` is supplied by the registry at tab-creation time.  Each browser
 * partition (`persist:browser-<workspaceId>`) belongs to exactly one workspace,
 * so binding it here is stable for the lifetime of the session.  (We do NOT
 * derive it from the session object: Electron's `Session` exposes no public
 * `partition` property — reading one yields `undefined` and crashes.)
 */
export function installPermissionHandler(
  session: import("electron").Session,
  deps?: PermissionHandlerDeps,
  workspaceId = "",
): void {
  // Legacy path (no deps): deny-by-default with the original simple allow-list.
  // Preserved so the existing security.test.ts continues to pass unmodified.
  if (!deps) {
    const ALLOWED_PERMISSIONS = new Set(["clipboard-sanitized-write"]);
    session.setPermissionRequestHandler((_webContents, permission, callback) => {
      const allowed = ALLOWED_PERMISSIONS.has(permission);
      if (!allowed) {
        logger.warn(`[permission] denied: ${permission}`);
      }
      callback(allowed);
    });
    return;
  }

  // Full path with deps: classify → evaluate → route.
  const { getGlobalGrant, getRemembered, promptManager } = deps;

  session.setPermissionCheckHandler((webContents, permission) => {
    // webContents may be null for session-level check calls.
    const origin = safeGetOrigin(webContents);
    if (origin === null) return false;

    const decision = evaluatePermission(workspaceId, origin, permission, {
      getGlobalGrant,
      getRemembered,
    });
    return decision === "allow";
  });

  session.setPermissionRequestHandler((webContents, permission, callback) => {
    const origin = safeGetOrigin(webContents);
    if (origin === null) {
      logger.warn(`[permission] denied: unparseable origin for ${permission}`);
      callback(false);
      return;
    }

    const decision = evaluatePermission(workspaceId, origin, permission, {
      getGlobalGrant,
      getRemembered,
    });

    promptManager.handlePermissionRequest(
      { workspaceId, origin, permission, webContentsId: webContents.id, decision },
      callback,
    );
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
  // SIGNATURE: unlike `will-navigate` (which is `(event, url)`),
  // `will-frame-navigate` passes a SINGLE consolidated event object — `url`,
  // `isMainFrame`, and `preventDefault()` all live on that one `details`
  // argument. Reading them off a (non-existent) second argument yields
  // `undefined`, which `isNavigationSchemeAllowed` rejects, silently blocking
  // EVERY frame navigation (incl. main-frame search submits) — the
  // "blocked: undefined" bug. The Electron 41 .d.ts types this event, so no
  // cast is needed.
  webContents.on("will-frame-navigate", (details) => {
    const { url, isMainFrame } = details;

    // Main-frame navigations are already covered by will-navigate; only
    // apply the frame-specific logic here to avoid double-blocking.
    if (isMainFrame) return;

    if (url === ABOUT_BLANK) return; // allowed for frame initialisation

    if (!isNavigationSchemeAllowed(url)) {
      details.preventDefault();
      logger.warn(`[will-frame-navigate] blocked: ${url}`);
    }
  });

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

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Attempts to extract the security origin from a WebContents URL.
 *
 * Snapshots `webContents.getURL()` at the moment the request arrives.  If the
 * URL is empty or cannot be parsed as a valid URL, returns null — the caller
 * must treat this as an immediate deny.
 *
 * Opaque origins (the string "null", returned by `new URL("about:blank").origin`
 * or cross-origin sandboxed frames) are also denied.  Permissions must only be
 * granted to attributable https/http origins; an opaque origin has no stable
 * identity and cannot be meaningfully allow-listed.
 */
function safeGetOrigin(webContents: WebContents | null): string | null {
  if (!webContents) return null;
  try {
    const url = webContents.getURL();
    if (!url) return null;
    const origin = new URL(url).origin;
    // "null" is the serialisation of an opaque origin (about:blank, data:, sandboxed
    // iframes).  An empty string is also non-attributable.  Both must be denied.
    if (origin === "null" || origin === "") return null;
    return origin;
  } catch {
    return null;
  }
}
