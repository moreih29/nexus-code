import type { Session } from "electron";
// Namespace import, as nexus-workspace.ts explains.
import * as electron from "electron";
import { createLogger } from "../../../shared/log/main";
import { PREVIEW_SCHEME } from "../../../shared/preview/document-url";
import { isScriptReadableRequest } from "../../infra/security/script-readable-request";
import { cancelsAppFileRequest } from "../window/app-csp";
import { cancelsPreviewRequest, NEXUS_PREVIEW_SCHEME } from "./nexus-preview";
import { NEXUS_WORKSPACE_SCHEME } from "./nexus-workspace";

// ---------------------------------------------------------------------------
// The app's own schemes, wired up together: Electron takes one call that
// registers every privileged scheme, and a session keeps one onBeforeRequest
// listener, the last one set, which guards the app window's file:// requests
// too (window/app-csp.ts).
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
 * Whether a request of the app's session is cancelled: one of the app's
 * schemes (cancelsAppSchemeRequest), or a file outside the renderer's folder
 * that would run or be read (cancelsAppFileRequest).
 */
export function cancelsAppRequest(resourceType: string, url: string, rendererDir: string): boolean {
  if (url.startsWith("file:")) return cancelsAppFileRequest(resourceType, url, rendererDir);
  return cancelsAppSchemeRequest(resourceType, url);
}

/**
 * Installs the app session's request guard on `session`: the read guard of
 * the app's schemes, which the HTML preview's pages (and whatever they
 * navigate or embed) reach from frames of this session, and the guard that
 * keeps the window's file:// 'self' to the renderer's folder (`rendererDir`).
 */
export function installAppRequestGuard(session: Session, rendererDir: string): void {
  session.webRequest.onBeforeRequest(
    { urls: ["nexus-workspace://*/*", `${PREVIEW_SCHEME}://*/*`, "file:///*", "file://*/*"] },
    (details, callback) => {
      const cancel = cancelsAppRequest(details.resourceType, details.url, rendererDir);
      if (cancel) logger.warn(`Blocked ${details.resourceType}: ${details.url}`);
      callback({ cancel });
    },
  );
}
