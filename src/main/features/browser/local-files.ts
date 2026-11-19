import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { OnBeforeRequestListenerDetails, Session, WebContents, WebFrameMain } from "electron";
import { createLogger } from "../../../shared/log/main";
import { isScriptReadableRequest } from "../../infra/security/script-readable-request";

const logger = createLogger("browser-security");
const guardedSessions = new WeakSet<Session>();
const committedUrls = new WeakMap<WebContents, string>();
const htmlExtensions = new Set([".html", ".htm", ".xhtml"]);

function isDescendant(folder: string, file: string, paths: typeof path): boolean {
  const relative = paths.relative(folder, file);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${paths.sep}`) &&
    !paths.isAbsolute(relative)
  );
}

/** The inputs have already been resolved to their real filesystem paths. */
export function isScopedFilePath(
  folder: string,
  file: string,
  home: string,
  paths = path,
): boolean {
  return (
    paths.relative(folder, paths.parse(folder).root) !== "" &&
    paths.relative(folder, home) !== "" &&
    !isDescendant(folder, home, paths) &&
    isDescendant(folder, file, paths)
  );
}

function isFileInHtmlFolder(pageUrl: string, currentUrl: string, requestUrl: string): boolean {
  if (!pageUrl.startsWith("file:") || !requestUrl.startsWith("file:")) return false;
  try {
    const page = fileURLToPath(pageUrl);
    // Fragments and query strings can change within the document. The file
    // that establishes the scope comes from its cross-document commit.
    if (path.relative(page, fileURLToPath(currentUrl)) !== "") return false;
    if (!htmlExtensions.has(path.extname(page).toLowerCase())) return false;
    const target = fileURLToPath(requestUrl);
    const folder = path.dirname(realpathSync.native(page));
    // Reject obvious out-of-folder paths before following the target's links.
    if (!isDescendant(path.dirname(page), target, path) && !isDescendant(folder, target, path)) {
      return false;
    }
    const realTarget = realpathSync.native(target);
    return (
      isScopedFilePath(folder, realTarget, realpathSync.native(homedir())) &&
      statSync(realTarget).isFile()
    );
  } catch {
    return false;
  }
}

function canReadLocalFile(details: OnBeforeRequestListenerDetails): boolean {
  const { frame, webContents, resourceType, url, initiatorOrigin } = details;
  if (!frame || !webContents || frame.detached) return false;
  const committedUrl = committedUrls.get(webContents);
  if (!committedUrl) return false;
  if (initiatorOrigin !== undefined && initiatorOrigin !== "file://") return false;
  const main = webContents.mainFrame;
  // A subframe navigation can report the destination frame. Reads made by
  // subframe documents themselves receive no separate grant.
  if (frame !== main && (resourceType !== "subFrame" || frame.parent !== main)) return false;
  return isFileInHtmlFolder(committedUrl, main.url, url);
}

/** Only the main HTML document can embed a local file in a direct child. */
export function canNavigateLocalFrame(
  contents: WebContents,
  url: string,
  frame: WebFrameMain | null,
  initiator: WebFrameMain | null | undefined,
): boolean {
  const committedUrl = committedUrls.get(contents);
  if (!url.startsWith("file:") || !committedUrl || !frame || frame.detached) {
    return false;
  }
  const main = contents.mainFrame;
  return (
    initiator === main && frame.parent === main && isFileInHtmlFolder(committedUrl, main.url, url)
  );
}

/** Adds a tab to the session-wide guard. Popups share the guard without gaining a scope. */
export function installLocalFileReadGuard(contents: WebContents): void {
  if (!committedUrls.has(contents)) {
    committedUrls.set(contents, "");
    contents.on("did-navigate", (_event, url) => committedUrls.set(contents, url));
  }
  const session = contents.session;
  if (guardedSessions.has(session)) return;
  guardedSessions.add(session);
  session.webRequest.onBeforeRequest({ urls: ["file://*/*"] }, (details, callback) => {
    const { resourceType, url } = details;
    let cancel = resourceType === "object";
    if (resourceType === "subFrame" || isScriptReadableRequest(resourceType, url)) {
      cancel = true;
      try {
        cancel = !canReadLocalFile(details);
      } catch {
        // A frame or tab may have gone away before Electron delivered the request.
      }
    }
    if (cancel) logger.warn(`[file-read] blocked ${resourceType}: ${url}`);
    callback({ cancel });
  });
}
