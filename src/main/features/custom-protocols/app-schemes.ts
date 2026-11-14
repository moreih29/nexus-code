import type { Session } from "electron";
// Namespace import, as nexus-workspace.ts explains.
import * as electron from "electron";
import { createLogger } from "../../../shared/log/main";
import { PREVIEW_SCHEME } from "../../../shared/preview/document-url";
import { isScriptReadableRequest } from "../../infra/security/script-readable-request";
import { cancelsPreviewRequest, NEXUS_PREVIEW_SCHEME } from "./nexus-preview";
import { NEXUS_WORKSPACE_SCHEME } from "./nexus-workspace";

// ---------------------------------------------------------------------------
// The app's own schemes, wired up together: Electron takes one call that
// registers every privileged scheme, and a session keeps one onBeforeRequest
// listener, the last one set.
// ---------------------------------------------------------------------------

const logger = createLogger("app-schemes");

/**
 * Registers nexus-workspace:// and nexus-preview:// as privileged schemes.
 * Must be called once, before `app.whenReady()`.
 */
export function registerAppSchemes(): void {
  electron.protocol.registerSchemesAsPrivileged([NEXUS_WORKSPACE_SCHEME, NEXUS_PREVIEW_SCHEME]);
}

/**
 * Whether a request of `resourceType` for `url`, of one of the app's schemes,
 * is cancelled. A workspace file is, when page script could read its bytes
 * (isScriptReadableRequest); a preview document, when anything but an iframe
 * loads it.
 */
export function cancelsAppSchemeRequest(resourceType: string, url: string): boolean {
  if (url.startsWith(`${PREVIEW_SCHEME}:`)) return cancelsPreviewRequest(resourceType);
  return isScriptReadableRequest(resourceType, url);
}

/**
 * Installs the read guard of the app's schemes on `session`. The HTML preview
 * runs workspace pages (and whatever they navigate or embed) in frames of the
 * app's own session, where these schemes are reachable.
 */
export function installAppSchemeRequestGuard(session: Session): void {
  session.webRequest.onBeforeRequest(
    { urls: ["nexus-workspace://*/*", `${PREVIEW_SCHEME}://*/*`] },
    (details, callback) => {
      const cancel = cancelsAppSchemeRequest(details.resourceType, details.url);
      if (cancel) logger.warn(`Blocked ${details.resourceType}: ${details.url}`);
      callback({ cancel });
    },
  );
}
