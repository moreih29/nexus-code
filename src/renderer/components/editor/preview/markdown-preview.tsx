// MarkdownPreview — renders user-supplied markdown via react-markdown.
//
// SECURITY MODEL (plan 60 issues 1, 6)
//   - `rehype-raw` is intentionally NOT used. Raw `<script>` and other HTML
//     in the source is therefore rendered as text, not parsed into DOM.
//   - Every link/image href flows through `classifyLinkHref`, which enforces
//     the workspace root prefix and the external-scheme allowlist.
//   - External URLs open via `window.open(_, "_blank", "noopener,noreferrer")`
//     which routes through the hardened `setWindowOpenHandler` in main.
//   - Workspace-relative images are served by the `nexus-workspace://` custom
//     protocol with its own realpath/symlink guard in main.
//
// LIVE SYNC
//   The component is purely a function of `source`. The owning EditorView
//   subscribes to `model.onDidChangeContent`, throttles with rAF, and feeds
//   the latest string here — re-render handles the rest.
//
// TYPOGRAPHY
//   We render into a `.md-preview` scoped container. Styles are inline-tailwind
//   for the body, and a small CSS file is loaded by the importer for the
//   element-level rules (h1..h6 sizing, code blocks, tables). max-width 72ch
//   for readability per design.md preview-area guide.

import { useCallback, useMemo, useRef } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { createLogger } from "../../../../shared/log/renderer";
import { openOrRevealEditor } from "../../../services/editor";
import {
  classifyLinkHref,
  type LinkClassifyContext,
} from "../../../services/editor/preview/link-router";
import { buildWorkspaceUrl } from "../../../services/editor/preview/workspace-url";
import { capPreviewSource, PREVIEW_TRUNCATED_MESSAGE } from "./constants";

const log = createLogger("markdown-preview");

interface MarkdownPreviewProps {
  source: string;
  workspaceId: string;
  /** Absolute (POSIX) path of the markdown file being previewed. */
  currentFileAbsPath: string;
  /** Absolute (POSIX) path of the workspace root. */
  workspaceRootAbsPath: string;
}

export function MarkdownPreview({
  source,
  workspaceId,
  currentFileAbsPath,
  workspaceRootAbsPath,
}: MarkdownPreviewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  // Strip a leading YAML frontmatter block before truncation so the cap
  // applies to the body the user actually sees rendered.
  const { text, truncated } = capPreviewSource(stripFrontmatter(source));

  const linkCtx: LinkClassifyContext = useMemo(
    () => ({ currentFileAbsPath, workspaceRootAbsPath, kind: "link" }),
    [currentFileAbsPath, workspaceRootAbsPath],
  );
  const imageCtx: LinkClassifyContext = useMemo(
    () => ({ currentFileAbsPath, workspaceRootAbsPath, kind: "image" }),
    [currentFileAbsPath, workspaceRootAbsPath],
  );

  // Anchor scrolling stays scoped to the preview container — we don't want a
  // `#foo` click to leak out to the page-level hash and confuse routing.
  const scrollToAnchor = useCallback((id: string) => {
    const container = containerRef.current;
    if (!container) return;
    // Markdown headings get auto-ids from react-markdown via remark-gfm; if
    // the target element is missing we fall back to the top of the container.
    const target = container.querySelector(`[id="${cssEscape(id)}"]`);
    if (target && target instanceof HTMLElement) {
      target.scrollIntoView({ behavior: "auto", block: "start" });
    }
  }, []);

  const onLinkClick = useCallback(
    (href: string, event: React.MouseEvent<HTMLAnchorElement>) => {
      event.preventDefault();
      const classified = classifyLinkHref(href, linkCtx);
      switch (classified.kind) {
        case "anchor":
          scrollToAnchor(classified.id);
          return;
        case "external":
          // Routes through setWindowOpenHandler → hardened allowlist.
          window.open(classified.href, "_blank", "noopener,noreferrer");
          return;
        case "internal-file":
          openOrRevealEditor({ workspaceId, filePath: classified.absPath }, { preview: true });
          return;
        case "blocked":
          log.warn(`blocked link click: ${classified.reason}`);
          return;
      }
    },
    [linkCtx, scrollToAnchor, workspaceId],
  );

  const components = useMemo<NonNullable<React.ComponentProps<typeof ReactMarkdown>["components"]>>(
    () => ({
      a({ href, children, ...rest }) {
        const safeHref = typeof href === "string" ? href : "";
        return (
          <a {...rest} href={safeHref} onClick={(e) => onLinkClick(safeHref, e)}>
            {children}
          </a>
        );
      },
      img({ src, alt, ...rest }) {
        const rawSrc = typeof src === "string" ? src : "";
        const resolved = resolveImageSrc(rawSrc, workspaceId, imageCtx);
        if (resolved === null) {
          // Blocked or empty — surface a tiny inline placeholder so the user
          // sees that an image was intended but not loaded.
          return (
            <span
              className="inline-flex items-center px-1.5 py-0.5 text-app-ui-sm text-muted-foreground border border-border rounded-(--radius-control)"
              title={`image not loaded: ${rawSrc}`}
            >
              [image]
            </span>
          );
        }
        return <img {...rest} src={resolved} alt={alt ?? ""} />;
      },
    }),
    [imageCtx, onLinkClick, workspaceId],
  );

  return (
    <div ref={containerRef} className="md-preview h-full min-h-0 overflow-auto">
      {truncated && (
        <div
          role="status"
          className="px-3 py-1 text-app-ui-sm text-[var(--state-warning-fg)] bg-[var(--state-warning-bg)] border-b border-[var(--state-warning-border)]"
        >
          {PREVIEW_TRUNCATED_MESSAGE}
        </div>
      )}
      <div className="mx-auto max-w-[72ch] px-6 py-4 text-[var(--surface-island-fg)]">
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
          {text}
        </ReactMarkdown>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Strip a leading YAML frontmatter block (Jekyll/Hugo/Obsidian convention)
 * from a markdown source so it is not rendered in the preview.
 *
 *   ---
 *   key: value
 *   ---
 *   <body>
 *
 * Two-stage match (see also the YAML-signature guard inside the body):
 *   - Fence: `---` at byte 0 (BOM tolerated), then any content, then a
 *     line that is exactly `---`, terminated by newline or end-of-file.
 *   - Guard: the matched block must contain at least one YAML-key line
 *     (`identifier:` at the start of a line). This protects live-preview
 *     users from accidentally erasing a markdown body that happens to sit
 *     between two `---` thematic breaks while they are typing.
 *
 * If either stage fails the source is returned unchanged and react-markdown
 * renders the lone `---` as a normal thematic break (`<hr>`).
 */
export function stripFrontmatter(source: string): string {
  const FRONTMATTER_RE = /^\uFEFF?---\r?\n(?:[\s\S]*?\r?\n)?---(?:\r?\n|$)/u;
  const match = FRONTMATTER_RE.exec(source);
  if (!match) return source;

  // YAML-signature guard. In a live preview, every keystroke re-renders.
  // A user typing `---\n# title\n---` (markdown body sandwiched between
  // two `---` thematic breaks) would otherwise have their visible body
  // silently erased \u2014 micromark / remark-frontmatter / gray-matter all
  // share this failure mode because the token rule is purely fence-based.
  // We additionally require that the matched block contain at least one
  // YAML-key-looking line (`identifier:` at start of line, m-flag).
  // Real frontmatter always satisfies this; markdown bodies between two
  // `---` rarely do. On failure we leave the source intact, so the opening
  // `---` renders as a normal `<hr>` \u2014 same outcome as VS Code / remark-
  // frontmatter when the closing fence is missing.
  const inner = match[0]
    .replace(/^\uFEFF?---\r?\n/u, "")
    .replace(/\r?\n---(?:\r?\n|$)/u, "");
  // YAML 1.2 allows any non-control Unicode character in plain keys.
  // `\p{L}` covers letters in every script (Hangul, Hiragana, Cyrillic, …),
  // `\p{N}` covers digits, `_` and `-` are the standard symbol additions.
  // First char excludes digit/`-` so list markers (`- item`) cannot match.
  const HAS_YAML_KEY = /^[\p{L}_][\p{L}\p{N}_-]*\s*:/mu;
  if (!HAS_YAML_KEY.test(inner)) return source;

  return source.replace(FRONTMATTER_RE, "");
}

/**
 * Resolve a markdown image `src` to a URL safe to drop into `<img>`:
 *   - empty → null (caller renders placeholder)
 *   - http(s) → unchanged (browser handles fetch; mixed-content rules apply)
 *   - workspace-relative → nexus-workspace:// URL
 *   - escape / disallowed scheme → null (caller renders placeholder)
 */
function resolveImageSrc(
  rawSrc: string,
  workspaceId: string,
  ctx: LinkClassifyContext,
): string | null {
  if (!rawSrc) return null;
  const classified = classifyLinkHref(rawSrc, ctx);
  switch (classified.kind) {
    case "external":
      return classified.href;
    case "internal-file":
      return buildWorkspaceUrl(workspaceId, classified.relPath);
    case "anchor":
    case "blocked":
      return null;
  }
}

/**
 * Minimal CSS.escape polyfill — older Electron versions may not expose it on
 * `window`, and we need to safely embed user-supplied anchor ids into a
 * querySelector selector.
 */
function cssEscape(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(value);
  }
  return value.replace(/[^a-zA-Z0-9_-]/g, (ch) => `\\${ch}`);
}
