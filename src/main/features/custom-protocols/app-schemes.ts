import type { Session } from "electron";
import * as electron from "electron";
import { createLogger } from "../../../shared/log/main";
import { PREVIEW_SCHEME } from "../../../shared/preview/document-url";
import { scopeIdOf } from "../../../shared/preview/scope-url";
import { isScriptReadableRequest } from "../../infra/security/script-readable-request";
import { cancelsAppFileRequest } from "../window/app-csp";
import { allowsEmbeddedNavigation } from "../window/frame-navigation";
import { cancelsPreviewRequest, NEXUS_PREVIEW_SCHEME } from "./nexus-preview";
import { NEXUS_WORKSPACE_SCHEME } from "./nexus-workspace";

const logger = createLogger("app-schemes");

export function registerAppSchemes(): void {
  electron.protocol.registerSchemesAsPrivileged([NEXUS_WORKSPACE_SCHEME, NEXUS_PREVIEW_SCHEME]);
}

function isScopedUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "nexus-workspace:" && scopeIdOf(parsed.host) !== null;
  } catch {
    return false;
  }
}

export function cancelsAppSchemeRequest(resourceType: string, url: string): boolean {
  if (url.startsWith(`${PREVIEW_SCHEME}:`)) return cancelsPreviewRequest(resourceType);
  if (resourceType === "xhr" && isScopedUrl(url)) return false;
  return isScriptReadableRequest(resourceType, url);
}

export function cancelsAppRequest(resourceType: string, url: string, rendererDir: string): boolean {
  if (url.startsWith("file:")) return cancelsAppFileRequest(resourceType, url, rendererDir);
  if (/^(https?|wss?):/.test(url)) return false;
  return cancelsAppSchemeRequest(resourceType, url);
}

const EMBEDDED_REMOTE_TYPES = new Set(["stylesheet", "script", "image", "font", "media"]);

export function cancelsEmbeddedRequest(resourceType: string, url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return true;
  }
  if (parsed.protocol === `${PREVIEW_SCHEME}:`) return false;
  if (parsed.protocol === "nexus-workspace:") return scopeIdOf(parsed.host) === null;
  if (parsed.protocol === "https:") return !EMBEDDED_REMOTE_TYPES.has(resourceType);
  return true;
}

export interface RequestFrame {
  readonly parent: RequestFrame | null;
}

export function cancelsFrameLoad(resourceType: string, url: string): boolean {
  return resourceType === "subFrame" && !allowsEmbeddedNavigation(url);
}

export function isEmbeddedFrame(frame: RequestFrame | null | undefined): boolean {
  return frame !== null && frame !== undefined && frame.parent !== null;
}

export const APP_REQUEST_URLS = [
  "nexus-workspace://*/*",
  `${PREVIEW_SCHEME}://*/*`,
  "file:///*",
  "file://*/*",
  "http://*/*",
  "https://*/*",
  "ws://*/*",
  "wss://*/*",
];

export function installAppRequestGuard(session: Session, rendererDir: string): void {
  session.webRequest.onBeforeRequest({ urls: APP_REQUEST_URLS }, (details, callback) => {
    const embedded = isEmbeddedFrame(details.frame);
    const cancel =
      cancelsAppRequest(details.resourceType, details.url, rendererDir) ||
      cancelsFrameLoad(details.resourceType, details.url) ||
      (embedded && cancelsEmbeddedRequest(details.resourceType, details.url));
    if (cancel) logger.warn(`Blocked ${details.resourceType}: ${details.url}`);
    callback({ cancel });
  });
  session.webRequest.onBeforeSendHeaders(
    { urls: ["http://*/*", "https://*/*", "ws://*/*", "wss://*/*"] },
    (details, callback) => {
      if (!isEmbeddedFrame(details.frame)) {
        callback({});
        return;
      }
      const requestHeaders = { ...details.requestHeaders };
      for (const name of Object.keys(requestHeaders)) {
        if (name.toLowerCase() === "cookie") delete requestHeaders[name];
      }
      callback({ requestHeaders });
    },
  );
}
