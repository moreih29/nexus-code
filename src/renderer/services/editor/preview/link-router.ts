// Markdown link / image classifier for the Preview pane.
//
// Five kinds of href appear in user-supplied markdown:
//
//   1. anchor                 `#section-id`        → scroll inside the preview
//   2. external (allowlisted) `https://...`        → shell.openExternal
//   3. internal-file (rooted) `./foo.md`           → openOrRevealEditor
//                             `../bar/baz.md`
//   4. blocked (escape)       `../../../../etc/passwd`
//   5. blocked (scheme)       `javascript:`, `file:`, `vscode:`, `data:` …
//
// Classify here, branch in the consumer. Centralising the decision means the
// security boundary lives in one tested function instead of being smeared
// across the markdown renderer's `a` and `img` overrides.
//
// Note on Windows: the renderer speaks POSIX-style absolute paths because
// EditorTabProps.filePath is already normalised by the main process before it
// reaches the store (see src/renderer/utils/path.ts). All path math below
// assumes `/` separators.

import { isWithinWorkspace, relPath } from "@/utils/path";
import { isExternalSchemeAllowed } from "../../../../shared/security/url-scheme";

export interface LinkClassifyContext {
  /** Absolute (POSIX) path to the file the markdown is rendered from. */
  currentFileAbsPath: string;
  /** Absolute (POSIX) path to the workspace root. */
  workspaceRootAbsPath: string;
  /**
   * Whether this href came from an `<a>` (default) or `<img>` element.
   * Image context refuses anchor-only hrefs (an image cannot scroll a
   * preview), which would otherwise classify as `anchor` and surprise the
   * consumer.
   */
  kind?: "link" | "image";
}

export type ClassifiedLink =
  | { kind: "anchor"; id: string }
  | { kind: "external"; href: string }
  | { kind: "internal-file"; absPath: string; relPath: string }
  | { kind: "blocked"; reason: string };

/**
 * Classify a raw markdown link href against the workspace root.
 *
 * `internal-file` is only produced when the resolved absolute path falls
 * strictly inside `workspaceRootAbsPath`. Any path that escapes — either
 * directly (`/etc/passwd`) or via `..` traversal — yields `blocked`.
 *
 * This function is pure and does not touch the filesystem; symlink escapes
 * must be defended by the actual file loader (e.g. the custom protocol
 * handler does a `fs.realpath` check). Pre-checking with `fs.realpath` here
 * would require an async API and is unnecessary for the React renderer's
 * click decision.
 */
export function classifyLinkHref(href: string, ctx: LinkClassifyContext): ClassifiedLink {
  if (!href) return { kind: "blocked", reason: "empty href" };

  // 1. Anchor (`#section`). Only meaningful for <a>; an <img> with `#foo`
  //    is malformed for our purposes.
  if (href.startsWith("#")) {
    if (ctx.kind === "image") {
      return { kind: "blocked", reason: "anchor href on image" };
    }
    return { kind: "anchor", id: href.slice(1) };
  }

  // 2. URL with a scheme (http:, https:, mailto:, javascript:, vscode: …).
  //    URL parsing only succeeds if a recognised scheme is present at the
  //    head of the string. Bare paths (`./foo.md`, `foo.md`) fall through
  //    to the relative-path branch below.
  if (hasUrlScheme(href)) {
    return isExternalSchemeAllowed(href)
      ? { kind: "external", href }
      : { kind: "blocked", reason: `disallowed scheme in ${href}` };
  }

  // 3. Relative (or accidentally absolute) workspace path. Resolve against
  //    the current file's directory, then verify the result is rooted
  //    inside the workspace.
  const baseDir = posixDirname(ctx.currentFileAbsPath);
  const absPath = posixResolve(baseDir, href);
  if (!isWithinWorkspace(absPath, ctx.workspaceRootAbsPath)) {
    return { kind: "blocked", reason: `escape outside workspace: ${href}` };
  }

  return {
    kind: "internal-file",
    absPath,
    relPath: relPath(absPath, ctx.workspaceRootAbsPath),
  };
}

// ---------------------------------------------------------------------------
// Helpers — POSIX-only, no Node dependency
// ---------------------------------------------------------------------------

/**
 * True when `href` begins with a recognisable URL scheme.
 *
 * Anything matching `^[a-z][a-z0-9+.-]*:` (per RFC 3986) is treated as
 * scheme-prefixed. We deliberately do not use `new URL()` here because we
 * want to detect *any* scheme to route through `isExternalSchemeAllowed`,
 * including malformed ones that should be blocked. A simple regex is the
 * right boundary for that routing decision.
 */
function hasUrlScheme(href: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(href);
}

/** Parent of a POSIX absolute path. `/a/b/c.md` → `/a/b`. */
function posixDirname(absPath: string): string {
  const idx = absPath.lastIndexOf("/");
  if (idx <= 0) return "/";
  return absPath.slice(0, idx);
}

/**
 * Resolve `relPath` against `baseDir`, then normalise `.` and `..` segments.
 * If `relPath` is itself absolute it wins; otherwise it joins onto `baseDir`.
 * Mirrors `path.posix.resolve` for the simple two-argument case.
 */
function posixResolve(baseDir: string, target: string): string {
  const combined = target.startsWith("/") ? target : `${baseDir}/${target}`;
  return normalizePosix(combined);
}

/** Collapse `.` / `..` / repeated `/` in a POSIX absolute path. */
function normalizePosix(p: string): string {
  const isAbs = p.startsWith("/");
  const parts = p.split("/");
  const stack: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      stack.pop();
      continue;
    }
    stack.push(part);
  }
  return (isAbs ? "/" : "") + stack.join("/");
}

// Test-only surface — covers helpers without leaking them into the public API.
export const __testing = { hasUrlScheme, posixDirname, posixResolve, normalizePosix };
