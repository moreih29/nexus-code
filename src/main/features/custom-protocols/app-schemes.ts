import path from "node:path";
import type { Session } from "electron";
import * as electron from "electron";
import { createLogger } from "../../../shared/log/main";
import { PREVIEW_SCHEME } from "../../../shared/preview/document-url";
import { scopeIdOf } from "../../../shared/preview/scope-url";
import { isScriptReadableRequest } from "../../infra/security/script-readable-request";
import {
  type AppPage,
  appContentSecurityPolicy,
  appPageUrlPatterns,
  cancelsAppFileRequest,
  cspHeaderName,
  isAppPageUrl,
} from "../window/app-csp";
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

export function installAppRequestGuard(session: Session, page: AppPage, reportOnly = false): void {
  const rendererDir = path.dirname(page.indexPath);
  const policy = appContentSecurityPolicy(page.devServerUrl);
  const policyHeader = cspHeaderName(reportOnly);
  if (reportOnly) logger.warn(`The app window's policy only reports: ${policy}`);

  const embeddedRequests = new Set<number>();
  session.webRequest.onBeforeRequest({ urls: APP_REQUEST_URLS }, (details, callback) => {
    const embedded = embeddedRequests.has(details.id) || isEmbeddedFrame(details.frame);
    const cancel =
      cancelsAppRequest(details.resourceType, details.url, rendererDir) ||
      cancelsFrameLoad(details.resourceType, details.url) ||
      (embedded && cancelsEmbeddedRequest(details.resourceType, details.url));
    if (cancel) logger.warn(`Blocked ${details.resourceType}: ${details.url}`);
    if (!cancel && embedded && details.url.startsWith("https:")) embeddedRequests.add(details.id);
    callback({ cancel });
  });
  session.webRequest.onBeforeSendHeaders(
    { urls: ["http://*/*", "https://*/*", "ws://*/*", "wss://*/*"] },
    (details, callback) => {
      if (!embeddedRequests.has(details.id) && !isEmbeddedFrame(details.frame)) {
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
  session.webRequest.onHeadersReceived(
    { urls: [...appPageUrlPatterns(page), "https://*/*"] },
    (details, callback) => {
      if (details.resourceType === "mainFrame" && isAppPageUrl(details.url, page)) {
        const responseHeaders = { ...details.responseHeaders };
        for (const name of Object.keys(responseHeaders)) {
          if (name.toLowerCase().startsWith("content-security-policy"))
            delete responseHeaders[name];
        }
        responseHeaders[policyHeader] = [policy];
        callback({ responseHeaders });
        return;
      }
      if (!embeddedRequests.has(details.id) || !details.url.startsWith("https:")) {
        callback({});
        return;
      }
      const responseHeaders = { ...details.responseHeaders };
      const cookieHeaders = Object.keys(responseHeaders).filter(
        (name) => name.toLowerCase() === "set-cookie",
      );
      if (cookieHeaders.length === 0) {
        callback({});
        return;
      }
      for (const name of cookieHeaders) delete responseHeaders[name];
      callback({ responseHeaders });
    },
  );
  const forgetEmbeddedRequest = ({ id }: { id: number }) => embeddedRequests.delete(id);
  session.webRequest.onCompleted(forgetEmbeddedRequest);
  session.webRequest.onErrorOccurred(forgetEmbeddedRequest);
}
