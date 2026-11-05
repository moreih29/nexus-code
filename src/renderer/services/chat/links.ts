// What a Claude tab does with the files and addresses its conversation
// names: where a path points, which kind of file it is, and whether an
// address is the machine's own. Pure, for the tab and its tests.

import { loopbackPort } from "../../../shared/pty/ports";
import { isDocxFile } from "../editor/preview/docx";
import { isFontFile } from "../editor/preview/font";
import { mediaKindFor } from "../editor/preview/media";
import { isPdfFile } from "../editor/preview/pdf";
import { isPresentationFile } from "../editor/preview/pptx";
import { isImageFile, isPreviewable, previewEngineFor } from "../editor/preview/previewable";
import { isSpreadsheetFile } from "../editor/preview/spreadsheet";
import type { ResultEntry } from "./panel";

/**
 * The absolute path a link or a reply names, against the session's folder:
 * a `file://` URL, an absolute path, or one relative to `cwd`. A line or
 * an anchor after `#` is left out. Null for a path from the home folder,
 * whose home the app does not know, and for anything else.
 */
export function resolveFilePath(target: string, cwd: string): string | null {
  let path = target.trim();
  if (!path) return null;
  if (path.startsWith("file://")) {
    try {
      path = decodeURIComponent(new URL(path).pathname);
    } catch {
      return null;
    }
  } else if (/^[a-z][a-z0-9+.-]*:/i.test(path)) {
    return null;
  } else {
    path = safeDecode(path.replace(/[#?].*$/, ""));
  }
  if (!path || path.startsWith("~")) return null;
  const joined = path.startsWith("/") ? path : `${cwd.replace(/\/+$/, "")}/${path}`;
  return normalize(joined);
}

function safeDecode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/** `.` and `..` resolved, repeated and trailing slashes dropped. */
function normalize(path: string): string {
  const out: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return `/${out.join("/")}`;
}

/** The session's results that are files, as absolute paths, each once. */
export function resultFiles(results: ResultEntry[], cwd: string): string[] {
  const files: string[] = [];
  for (const result of results) {
    if (result.kind !== "file") continue;
    const path = resolveFilePath(result.target, cwd);
    if (path && !files.includes(path)) files.push(path);
  }
  return files;
}

/** Whether `path` is `root` or under it. */
export function isUnder(path: string, root: string): boolean {
  const base = root.replace(/\/+$/, "");
  return base !== "" && (path === base || path.startsWith(`${base}/`));
}

/**
 * Whether an address is the machine's own, which the app's browser opens:
 * localhost and its subdomains, the loopback addresses, and 0.0.0.0.
 */
export function isLocalAddress(url: string): boolean {
  return loopbackPort(url) !== null;
}

export type FileKind =
  | "image"
  | "video"
  | "audio"
  | "font"
  | "pdf"
  | "sheet"
  | "doc"
  | "slides"
  | "data"
  | "page"
  | "code"
  | "text"
  | "folder";

const CODE_EXT =
  /\.(c|cc|cpp|cs|css|go|h|hpp|java|js|jsx|kt|lua|m|mjs|cjs|php|pl|py|rb|rs|scss|sh|sql|swift|ts|tsx|vue|zsh)$/i;

/** Which kind of file a path names, for its icon. */
export function fileKind(path: string): FileKind {
  if (path.endsWith("/")) return "folder";
  if (isImageFile(path) || /\.svg$/i.test(path)) return "image";
  const media = mediaKindFor(path);
  if (media) return media;
  if (isFontFile(path)) return "font";
  if (isPdfFile(path)) return "pdf";
  if (isSpreadsheetFile(path)) return "sheet";
  if (isDocxFile(path)) return "doc";
  if (isPresentationFile(path)) return "slides";
  if (isPreviewable(path) !== "none") {
    const engine = previewEngineFor(path);
    if (engine === "json" || engine === "yaml" || engine === "table") return "data";
    if (engine === "markdown" || engine === "html" || engine === "notebook") return "page";
  }
  if (CODE_EXT.test(path)) return "code";
  return "text";
}

/** The last part of a path, without the folders. */
export function baseName(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  return trimmed.slice(trimmed.lastIndexOf("/") + 1) || path;
}
