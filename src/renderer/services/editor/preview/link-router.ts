import { isWithinWorkspace, relativeTo } from "@/utils/path";
import { reducePosixSegments } from "../../../../shared/fs/posix-segments";
import { isExternalSchemeAllowed } from "../../../../shared/security/url-scheme";

export interface LinkClassifyContext {
  currentFileAbsPath: string;
  workspaceRootAbsPath: string;
  kind?: "link" | "image";
}

export type ClassifiedLink =
  | { kind: "anchor"; id: string }
  | { kind: "external"; href: string }
  | { kind: "internal-file"; absPath: string; relPath: string }
  | { kind: "blocked"; reason: string };

export function classifyLinkHref(href: string, ctx: LinkClassifyContext): ClassifiedLink {
  if (!href) return { kind: "blocked", reason: "empty href" };

  if (href.startsWith("#")) {
    if (ctx.kind === "image") {
      return { kind: "blocked", reason: "anchor href on image" };
    }
    return { kind: "anchor", id: href.slice(1) };
  }

  if (hasUrlScheme(href)) {
    return isExternalSchemeAllowed(href)
      ? { kind: "external", href }
      : { kind: "blocked", reason: `disallowed scheme in ${href}` };
  }

  const filePath = decodeHrefPath(href.replace(/[?#].*$/, ""));
  if (!filePath) return { kind: "blocked", reason: `no file path in ${href}` };
  const baseDir = posixDirname(ctx.currentFileAbsPath);
  const absPath = posixResolve(baseDir, filePath);
  if (!isWithinWorkspace(absPath, ctx.workspaceRootAbsPath)) {
    return { kind: "blocked", reason: `escape outside workspace: ${href}` };
  }

  return {
    kind: "internal-file",
    absPath,
    relPath: relativeTo(absPath, ctx.workspaceRootAbsPath),
  };
}

export function linkTargetPath(href: string, currentFileAbsPath: string): string | null {
  const drive = /^[A-Za-z]:[\\/]/.test(href);
  if (!href || href.startsWith("#") || (!drive && hasUrlScheme(href))) return null;
  const filePath = decodeHrefPath(href.replace(/[?#].*$/, "")).replace(/\\/g, "/");
  if (!filePath) return null;
  return drive
    ? normalizePosix(filePath)
    : posixResolve(posixDirname(currentFileAbsPath), filePath);
}

function hasUrlScheme(href: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(href);
}

function decodeHrefPath(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function posixDirname(absPath: string): string {
  const idx = absPath.lastIndexOf("/");
  if (idx <= 0) return "/";
  return absPath.slice(0, idx);
}

function posixResolve(baseDir: string, target: string): string {
  const combined = target.startsWith("/") ? target : `${baseDir}/${target}`;
  return normalizePosix(combined);
}

function normalizePosix(p: string): string {
  const isAbs = p.startsWith("/");
  const stack = reducePosixSegments(p, {
    emptySegments: "discard",
    leadingParents: "discard",
  });
  return (isAbs ? "/" : "") + stack.join("/");
}

export const __testing = { hasUrlScheme, posixDirname, posixResolve, normalizePosix };
