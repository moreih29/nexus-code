import { slashWindowsPath } from "../../../shared/fs/relative-path";

import { loopbackPort } from "../../../shared/pty/ports";
import { isDocxFile } from "../editor/preview/docx";
import { isFontFile } from "../editor/preview/font";
import { mediaKindFor } from "../editor/preview/media";
import { isPdfFile } from "../editor/preview/pdf";
import { isPresentationFile } from "../editor/preview/pptx";
import { isImageFile, isPreviewable, previewEngineFor } from "../editor/preview/previewable";
import { isSpreadsheetFile } from "../editor/preview/spreadsheet";
import type { ResultEntry } from "./panel";

const DRIVE_PATH = /^[A-Za-z]:([\\/]|$)/;

const DRIVE_LINK = /^[A-Za-z]:([\\/]|%5C|$)/i;

export interface FileLink {
  path: string;
  line?: number;
  column?: number;
  literal?: string;
}

export type LineAt = Pick<FileLink, "line" | "column">;

const LINE_SUFFIX = /:(\d+)(?::(\d+))?$/;

const LINE_ANCHOR = /^#L(\d+)(?!\d)/i;

export function resolveFilePath(target: string, cwd: string): string | null {
  return resolveFileLink(target, cwd)?.path ?? null;
}

export function resolveFileLink(target: string, cwd: string): FileLink | null {
  const link = readLink(target, cwd);
  if (!link) return null;
  const absolute = absolutePath(link.path, link.windows, cwd);
  if (absolute === null) return null;
  const { written, windows, at } = link;
  const literal = written !== undefined && !windows ? absolutePath(written, false, cwd) : null;
  return { path: absolute, ...at, ...(literal ? { literal } : {}) };
}

export function relativeLinkPath(target: string, cwd: string): string | null {
  const link = readLink(target, cwd);
  if (!link || link.windows) return null;
  const { path } = link;
  return path && !path.startsWith("/") && !path.startsWith("~") ? path : null;
}

interface WrittenLink {
  path: string;
  at: Omit<FileLink, "path" | "literal">;
  written?: string;
  windows: boolean;
}

function readLink(target: string, cwd: string): WrittenLink | null {
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
  const line = LINE_ANCHOR.exec(anchor);
  if (at.line === undefined && line) at = { line: Number(line[1]) };
  return { path, at, ...(written !== undefined ? { written } : {}), windows };
}

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

function normalize(path: string): string {
  const drive = (/^[A-Za-z]:(?=\/|$)/.exec(path)?.[0] ?? "").toUpperCase();
  const out: string[] = [];
  for (const part of path.slice(drive.length).split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return `${drive}/${out.join("/")}`;
}

export function resultFiles(results: ResultEntry[], cwd: string): string[] {
  const files: string[] = [];
  for (const result of results) {
    if (result.kind !== "file") continue;
    const path = resolveFilePath(result.target, cwd);
    if (path && !files.includes(path)) files.push(path);
  }
  return files;
}

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

export function baseName(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  return trimmed.slice(trimmed.lastIndexOf("/") + 1) || path;
}
