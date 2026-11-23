import type { WebContents, WebPreferences } from "electron";
import { createLogger } from "../../../shared/log/main";
import {
  classifyPermission,
  isKnownPermission,
} from "../../../shared/security/browser-permissions";
import {
  isBuiltinPdfViewerUrl,
  isNavigationSchemeAllowed,
  isPopupNavigationAllowed,
  isSubframeNavigationAllowed,
} from "../../../shared/security/navigation-allowlist";
import { excludeFromBroadcast } from "../../infra/ipc-router";
import { UserActivation, watchActivation } from "../window/activation";
import { canNavigateLocalFrame } from "./local-files";
import { resolvePermission } from "./permission-policy";
import type { BrowserPermissionPromptManager } from "./permission-prompt-manager";

const logger = createLogger("browser-security");

export function buildBrowserTabWebPreferences(partition: string): WebPreferences {
  return {
    partition,
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    webSecurity: true,
  };
}

export interface PermissionHandlerDeps {
  getGlobalGrant(permission: string): boolean;
  getRemembered(workspaceId: string, origin: string, permission: string): "allow" | "block" | null;
  promptManager: BrowserPermissionPromptManager;
}

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

  return resolvePermission({
    globalAllowed: deps.getGlobalGrant(permission),
    remembered: deps.getRemembered(workspaceId, origin, permission),
    isKnownPermission: isKnownPermission(permission),
  });
}

export function installPermissionHandler(
  session: import("electron").Session,
  deps?: PermissionHandlerDeps,
  workspaceId = "",
): void {
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

  const { getGlobalGrant, getRemembered, promptManager } = deps;

  session.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) => {
    const origin = safeGetOrigin(webContents, requestingOrigin, details);
    if (origin === null) return false;

    const decision = evaluatePermission(workspaceId, origin, permission, {
      getGlobalGrant,
      getRemembered,
    });
    return decision === "allow";
  });

  session.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const origin = safeGetOrigin(webContents, undefined, details);
    if (origin === null) {
      logger.warn(`[permission] denied: unparseable origin for ${permission}`);
      callback(false);
      return;
    }

    const decision = evaluatePermission(workspaceId, origin, permission, {
      getGlobalGrant,
      getRemembered,
    });

    if (decision === "ask") {
      disposePromptsWithPage(webContents, promptManager);
    }
    promptManager.handlePermissionRequest(
      { workspaceId, origin, permission, webContentsId: webContents.id, decision },
      callback,
    );
  });
}

const promptLifetimeTracked = new Set<number>();

function disposePromptsWithPage(
  webContents: WebContents,
  promptManager: BrowserPermissionPromptManager,
): void {
  const id = webContents.id;
  if (promptLifetimeTracked.has(id)) return;
  promptLifetimeTracked.add(id);
  webContents.on("did-start-navigation", (details) => {
    if (details.isMainFrame && !details.isSameDocument) {
      promptManager.disposeByWebContents(id);
    }
  });
  webContents.once("destroyed", () => {
    promptLifetimeTracked.delete(id);
    promptManager.disposeByWebContents(id);
  });
}

const ABOUT_BLANK = "about:blank";

export const POPUP_ACTIVATION_MS = 5_000;

export function installNavigationGuards(
  webContents: WebContents,
  onNavigate?: (url: string) => void,
  onPopup?: (popup: import("electron").BrowserWindow) => void,
  popup = false,
): void {
  const allowed = popup ? isPopupNavigationAllowed : isNavigationSchemeAllowed;
  excludeFromBroadcast(webContents);

  webContents.on("will-navigate", (event, url) => {
    if (
      !allowed(url) ||
      (url.startsWith("file:") && event.initiator && event.initiator !== webContents.mainFrame)
    ) {
      event.preventDefault();
      logger.warn("[will-navigate] blocked");
      return;
    }
    onNavigate?.(url);
  });

  webContents.on("will-frame-navigate", (details) => {
    const { url, isMainFrame } = details;

    if (isMainFrame) return;

    if (url === ABOUT_BLANK) return;

    if (isBuiltinPdfViewerUrl(url)) return;

    if (
      !isSubframeNavigationAllowed(url) &&
      !canNavigateLocalFrame(webContents, url, details.frame, details.initiator)
    ) {
      details.preventDefault();
      logger.warn("[will-frame-navigate] blocked");
    }
  });
  webContents.on("will-redirect", (details) => {
    if (details.url.startsWith("file:") && (popup || !details.isMainFrame)) {
      details.preventDefault();
    }
  });

  const activation = new UserActivation(Date.now, POPUP_ACTIVATION_MS);
  watchActivation(webContents, activation);
  webContents.setWindowOpenHandler(({ url }) => {
    if (isPopupNavigationAllowed(url) && !activation.take()) {
      logger.warn("[window-open] blocked without user input");
      return { action: "deny" };
    }
    if (isPopupNavigationAllowed(url)) {
      return {
        action: "allow",
        overrideBrowserWindowOptions: {
          webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            webSecurity: true,
          },
        },
      };
    }
    logger.warn("[window-open] blocked");
    return { action: "deny" };
  });

  webContents.on("did-create-window", (childWindow) => {
    onPopup?.(childWindow);
    installNavigationGuards(childWindow.webContents, undefined, onPopup, true);
  });
}

interface PermissionSource {
  isMainFrame?: boolean;
  requestingUrl?: string;
  securityOrigin?: string;
}

function safeGetOrigin(
  webContents: WebContents | null,
  requestingOrigin?: string,
  details?: PermissionSource,
): string | null {
  if (!webContents) return null;
  try {
    const source = requestingOrigin || details?.securityOrigin || details?.requestingUrl;
    const url = source || (details?.isMainFrame === false ? undefined : webContents.getURL());
    if (!url) return null;
    const origin = new URL(url).origin;
    return origin === "null" ? null : origin;
  } catch {
    return null;
  }
}
