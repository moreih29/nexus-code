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

/** A Windows path from its drive: `C:\…`, `C:/…`, or the drive itself. */
const DRIVE_PATH = /^[A-Za-z]:([\\/]|$)/;

/** A link to a Windows path, whose `\` a markdown link carries escaped (`C:%5C…`). */
const DRIVE_LINK = /^[A-Za-z]:([\\/]|%5C|$)/i;

/**
 * A Windows path written with `/`, as the app writes its paths there
 * (`C:\w\a.ts` → `C:/w/a.ts`); any other path as it is. Codex and Claude
 * write Windows paths with `\`.
 */
export function slashWindowsPath(path: string): string {
  return DRIVE_PATH.test(path) ? path.replace(/\\/g, "/") : path;
}

/** A file a link names, and the line in it the link points at. */
export interface FileLink {
  /** The file's absolute path, as resolveFilePath gives it. */
  path: string;
  /** The line, from 1, and its column when the link names one. */
  line?: number;
  column?: number;
  /**
   * The path with its `:12` kept, where a file name may hold a colon (not
   * on Windows): a file of that name is the one meant, when there is one.
   */
  literal?: string;
}

/** Where in a file to open it: a line, from 1, and maybe its column. */
export type LineAt = Pick<FileLink, "line" | "column">;

/** `:12` or `:12:5` ending a path, as Codex and compilers name a line. */
const LINE_SUFFIX = /:(\d+)(?::(\d+))?$/;

/** `#L12`, as GitHub names a line; of `#L12-L20`, the first. */
const LINE_ANCHOR = /^#L(\d+)(?!\d)/i;

/**
 * The absolute path a link or a reply names, against the session's folder:
 * a `file://` URL, an absolute path, or one relative to `cwd`. A line
 * (`:12`, `#L12`) or another anchor is left out. Null for a path from the
 * home folder, whose home the app does not know, and for anything else. A
 * Windows path (`C:\…`, or any path where the folder is one) comes back as
 * the app writes it, `C:/…`.
 */
export function resolveFilePath(target: string, cwd: string): string | null {
  return resolveFileLink(target, cwd)?.path ?? null;
}

/** The file a link names, as resolveFilePath finds it, with the line it points at. */
export function resolveFileLink(target: string, cwd: string): FileLink | null {
  let path = target.trim();
  if (!path) return null;
  let windows = DRIVE_PATH.test(cwd);
  let anchor = "";
  let at: Omit<FileLink, "path" | "literal"> = {};
  let written: string | undefined;
  if (path.startsWith("file://")) {
    try {
      const url = new URL(path);
      path = decodeURIComponent(url.pathname);
      anchor = url.hash;
    } catch {
      return null;
    }
    // file:///C:/a.ts has the pathname /C:/a.ts.
    if (/^\/[A-Za-z]:\//.test(path)) {
      path = path.slice(1);
      windows = true;
    }
    ({ path, at, written } = splitLine(path, windows));
  } else {
    anchor = /#.*$/.exec(path)?.[0] ?? "";
    path = path.replace(/[#?].*$/, "");
    ({ path, at, written } = splitLine(path, DRIVE_LINK.test(path)));
    if (DRIVE_LINK.test(path)) windows = true;
    else if (/^[a-z][a-z0-9+.-]*:/i.test(path)) return null;
    path = safeDecode(path);
    if (written !== undefined) written = safeDecode(written);
  }
  const absolute = absolutePath(path, windows, cwd);
  if (absolute === null) return null;
  const line = LINE_ANCHOR.exec(anchor);
  if (at.line === undefined && line) at = { line: Number(line[1]) };
  const literal = written !== undefined && !windows ? absolutePath(written, false, cwd) : null;
  return { path: absolute, ...at, ...(literal ? { literal } : {}) };
}

/**
 * A path without the line ending it, and the path as written. Only what
 * reads as a file takes a line (`a.ts:12`, `src/Makefile:3`, a drive's
 * path), so `tel:123` stays a scheme.
 */
function splitLine(
  path: string,
  drive: boolean,
): { path: string; at: Omit<FileLink, "path" | "literal">; written?: string } {
  const suffix = LINE_SUFFIX.exec(path);
  const rest = suffix ? path.slice(0, suffix.index) : "";
  if (!suffix || !(drive || /[./\\]/.test(rest))) return { path, at: {} };
  const at = { line: Number(suffix[1]), ...(suffix[2] ? { column: Number(suffix[2]) } : {}) };
  return { path: rest, at, written: path };
}

/** A path made absolute against `cwd`; null for one from the home folder. */
function absolutePath(path: string, windows: boolean, cwd: string): string | null {
  if (!path || path.startsWith("~")) return null;
  if (windows) {
    path = path.replace(/\\/g, "/");
    if (DRIVE_PATH.test(path)) return normalize(path);
  }
  const joined = path.startsWith("/")
    ? path
    : `${slashWindowsPath(cwd).replace(/\/+$/, "")}/${path}`;
  return normalize(joined);
}

function safeDecode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/** `.` and `..` resolved, repeated and trailing slashes dropped; a Windows drive kept in front. */
function normalize(path: string): string {
  const drive = /^[A-Za-z]:(?=\/|$)/.exec(path)?.[0] ?? "";
  const out: string[] = [];
  for (const part of path.slice(drive.length).split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return `${drive}/${out.join("/")}`;
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

/** Whether `path` is `root` or under it; under a Windows root, whatever the case. */
export function isUnder(path: string, root: string): boolean {
  const windows = DRIVE_PATH.test(root);
  const fold = (p: string) => (windows ? slashWindowsPath(p).toLowerCase() : p);
  const base = fold(root).replace(/\/+$/, "");
  const target = fold(path);
  return base !== "" && (target === base || target.startsWith(`${base}/`));
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
