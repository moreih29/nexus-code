import type { Session } from "electron";
import * as electron from "electron";
import { createLogger } from "../../../shared/log/main";
import { PREVIEW_SCHEME } from "../../../shared/preview/document-url";
import { isScriptReadableRequest } from "../../infra/security/script-readable-request";
import { cancelsAppFileRequest } from "../window/app-csp";
import { cancelsPreviewRequest, NEXUS_PREVIEW_SCHEME } from "./nexus-preview";
import { NEXUS_WORKSPACE_SCHEME } from "./nexus-workspace";

const logger = createLogger("app-schemes");

export function registerAppSchemes(): void {
  electron.protocol.registerSchemesAsPrivileged([NEXUS_WORKSPACE_SCHEME, NEXUS_PREVIEW_SCHEME]);
}

export function cancelsAppSchemeRequest(resourceType: string, url: string): boolean {
  if (url.startsWith(`${PREVIEW_SCHEME}:`)) return cancelsPreviewRequest(resourceType);
  return isScriptReadableRequest(resourceType, url);
}

export function cancelsAppRequest(resourceType: string, url: string, rendererDir: string): boolean {
  if (url.startsWith("file:")) return cancelsAppFileRequest(resourceType, url, rendererDir);
  return cancelsAppSchemeRequest(resourceType, url);
}

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
