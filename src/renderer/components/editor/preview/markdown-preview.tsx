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
// INTERACTIVITY (preview → source and view-only affordances)
//   - Task-list checkboxes (`- [ ]`) are interactive when `onToggleTask` is
//     supplied (writable file). The `li` node carries the source position;
//     the synthetic `input` node does NOT, so `li` publishes its model line
//     through `TaskLineContext` and `input` reads it back to toggle. Line
//     numbers from the AST are relative to the frontmatter-stripped body, so
//     `frontmatterLineOffset` is added back to reach true model lines.
//   - Code blocks get a hover "Copy" button (view-only; never edits source).
//   - Headings get an auto `id` (rehype-slug) plus a hover "#" anchor-copy
//     button and a fold toggle that collapses the section below them. Folding
//     is a pure view state (a Set of heading ids) reapplied to the DOM after
//     every live-sync re-render — it never touches the source.
//
// TYPOGRAPHY
//   We render into a `.md-preview` scoped container. Styles are inline-tailwind
//   for the body, and a small CSS file is loaded by the importer for the
//   element-level rules (h1..h6 sizing, code blocks, tables). max-width 72ch
//   for readability per design.md preview-area guide.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import rehypeSlug from "rehype-slug";
import remarkGfm from "remark-gfm";
import { createLogger } from "../../../../shared/log/renderer";
import { openOrRevealEditor } from "../../../services/editor";
import {
  classifyLinkHref,
  type LinkClassifyContext,
} from "../../../services/editor/preview/link-router";
import { buildWorkspaceUrl } from "../../../services/editor/preview/workspace-url";
import { copyText } from "../../../utils/clipboard";
import { capPreviewSource, PREVIEW_TRUNCATED_MESSAGE } from "./constants";

const log = createLogger("markdown-preview");

interface MarkdownPreviewProps {
  source: string;
  workspaceId: string;
  /** Absolute (POSIX) path of the markdown file being previewed. */
  currentFileAbsPath: string;
  /** Absolute (POSIX) path of the workspace root. */
  workspaceRootAbsPath: string;
  /**
   * Toggle a GFM task checkbox at the given 1-based MODEL line. When absent
   * (read-only file), checkboxes render disabled — same as plain react-markdown.
   */
  onToggleTask?: (modelLine: number) => void;
}

/**
 * Interactive affordances shared with the custom element renderers. Module-
 * level renderers read this instead of closing over props, so they satisfy
 * the rules-of-hooks (they are real components, mounted by react-markdown).
 */
interface PreviewContextValue {
  onToggleTask?: (modelLine: number) => void;
  frontmatterLineOffset: number;
  onCopyAnchor: (id: string) => void;
  collapsed: ReadonlySet<string>;
  toggleCollapse: (id: string) => void;
}

const PreviewContext = createContext<PreviewContextValue | null>(null);

/** Set by the `li` renderer (which has a source position) for `input` to read. */
const TaskLineContext = createContext<number | null>(null);

export function MarkdownPreview({
  source,
  workspaceId,
  currentFileAbsPath,
  workspaceRootAbsPath,
  onToggleTask,
}: MarkdownPreviewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Strip a leading YAML frontmatter block before truncation so the cap
  // applies to the body the user actually sees rendered. The number of lines
  // removed is the offset between AST line numbers (relative to the stripped
  // body) and true model lines — needed to write task toggles back correctly.
  const body = useMemo(() => stripFrontmatter(source), [source]);
  const frontmatterLineOffset = useMemo(
    () => (body === source ? 0 : countNewlines(source.slice(0, source.length - body.length))),
    [source, body],
  );
  const { text, truncated } = capPreviewSource(body);

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
    // rehype-slug gives headings stable ids; if the target is missing we fall
    // back to the top of the container.
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

  // ----- View-only interactivity state -------------------------------------
  const onCopyAnchor = useCallback((id: string) => {
    // Copy the in-document fragment. Users paste it into other markdown to
    // link a heading; it also matches what the anchor click-handler resolves.
    copyText(`#${id}`);
  }, []);

  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const toggleCollapse = useCallback((id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // Apply folds to the DOM after each render. Live-sync re-parses on every
  // keystroke, so collapsed sections must be re-hidden imperatively (the
  // rendered tree itself is always complete — folding is purely visual).
  // `text`/`frontmatterLineOffset` are intentional deps: the effect reads the
  // rendered DOM, which changes whenever those do, so it must re-run then —
  // biome can't see the DOM dependency and flags them as extraneous.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-apply folds after the rendered DOM changes
  useLayoutEffect(() => {
    const content = containerRef.current?.querySelector<HTMLElement>(".md-content");
    if (!content) return;
    const children = Array.from(content.children) as HTMLElement[];
    for (const el of children) el.removeAttribute("data-md-hidden");
    for (let i = 0; i < children.length; i++) {
      const level = headingLevel(children[i]);
      const id = children[i].id;
      if (level === null || !id || !collapsed.has(id)) continue;
      for (let j = i + 1; j < children.length; j++) {
        const siblingLevel = headingLevel(children[j]);
        if (siblingLevel !== null && siblingLevel <= level) break;
        children[j].setAttribute("data-md-hidden", "");
      }
    }
  }, [text, collapsed, frontmatterLineOffset]);

  const previewCtx = useMemo<PreviewContextValue>(
    () => ({ onToggleTask, frontmatterLineOffset, onCopyAnchor, collapsed, toggleCollapse }),
    [onToggleTask, frontmatterLineOffset, onCopyAnchor, collapsed, toggleCollapse],
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
      li: MdListItem,
      input: MdInput,
      pre: MdPre,
      h1: MdHeading,
      h2: MdHeading,
      h3: MdHeading,
      h4: MdHeading,
      h5: MdHeading,
      h6: MdHeading,
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
      <PreviewContext.Provider value={previewCtx}>
        <div className="md-content mx-auto max-w-[72ch] px-6 py-4 text-[var(--surface-island-fg)]">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            rehypePlugins={[
              rehypeSlug,
              // Syntax highlighting for fenced blocks with a language hint
              // (```python …). `detect: false` → only highlight when a language
              // is declared; `ignoreMissing: true` → unknown languages render
              // plain instead of throwing. Operates on the already-escaped code
              // text (emits <span class="hljs-*">), so it does NOT reintroduce
              // the raw-HTML parsing that the security model forbids.
              [rehypeHighlight, { detect: false, ignoreMissing: true }],
            ]}
            components={components}
          >
            {text}
          </ReactMarkdown>
        </div>
      </PreviewContext.Provider>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Custom element renderers
// ---------------------------------------------------------------------------

type RmNode = { tagName?: string; position?: { start?: { line?: number } }; properties?: Record<string, unknown>; children?: unknown[] };

/**
 * List item. For GFM task items (`<li class="task-list-item">`) on a writable
 * file, publishes this item's model line through TaskLineContext so the nested
 * checkbox can write a toggle back to the source.
 */
function MdListItem({ node, children, ...rest }: { node?: RmNode; children?: React.ReactNode }) {
  const ctx = useContext(PreviewContext);
  const className = (node?.properties?.className as string[] | undefined) ?? [];
  const isTask = Array.isArray(className) && className.includes("task-list-item");
  const astLine = node?.position?.start?.line;

  if (isTask && ctx?.onToggleTask && typeof astLine === "number") {
    const modelLine = astLine + ctx.frontmatterLineOffset;
    return (
      <li {...rest}>
        <TaskLineContext.Provider value={modelLine}>{children}</TaskLineContext.Provider>
      </li>
    );
  }
  return <li {...rest}>{children}</li>;
}

/**
 * Checkbox renderer. When inside an interactive task item (TaskLineContext set
 * and onToggleTask available) it becomes a live control; otherwise it renders
 * the standard disabled GFM checkbox.
 */
function MdInput({
  type,
  checked,
  node: _node,
  // `disabled` is dropped from `rest`: remark-gfm always sets it on the
  // synthetic checkbox, but the interactive branch must override it.
  disabled: _disabled,
  ...rest
}: {
  type?: string;
  checked?: boolean;
  disabled?: boolean;
  node?: RmNode;
}) {
  const ctx = useContext(PreviewContext);
  const modelLine = useContext(TaskLineContext);

  if (type === "checkbox" && ctx?.onToggleTask && modelLine != null) {
    return (
      <input
        {...rest}
        type="checkbox"
        className="md-task-checkbox"
        checked={Boolean(checked)}
        onChange={() => ctx.onToggleTask?.(modelLine)}
      />
    );
  }
  return <input {...rest} type={type} checked={Boolean(checked)} disabled readOnly />;
}

/** Code block with a hover "Copy" button. View-only — never edits the source. */
function MdPre({ node, children, ...rest }: { node?: RmNode; children?: React.ReactNode }) {
  const [copied, setCopied] = useState(false);
  const code = useMemo(() => hastToText(node), [node]);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);

  return (
    <div className="md-code-wrap">
      <button
        type="button"
        className="md-code-copy"
        tabIndex={-1}
        aria-label="Copy code"
        onClick={() => {
          copyText(code);
          setCopied(true);
        }}
      >
        {copied ? "Copied" : "Copy"}
      </button>
      <pre {...rest}>{children}</pre>
    </div>
  );
}

/**
 * Heading with a fold toggle (collapse the section below) and a "#" anchor-copy
 * button, both revealed on hover. The `id` comes from rehype-slug.
 */
function MdHeading({
  node,
  children,
  id,
  ...rest
}: {
  node?: RmNode;
  children?: React.ReactNode;
  id?: string;
}) {
  const ctx = useContext(PreviewContext);
  const Tag = (node?.tagName ?? "h2") as "h1" | "h2" | "h3" | "h4" | "h5" | "h6";
  const headingId = typeof id === "string" && id.length > 0 ? id : undefined;
  const isCollapsed = headingId ? ctx?.collapsed.has(headingId) : false;

  return (
    <Tag id={headingId} className="md-heading" data-collapsed={isCollapsed ? "" : undefined} {...rest}>
      {headingId && (
        <button
          type="button"
          className="md-heading-fold"
          tabIndex={-1}
          aria-label={isCollapsed ? "Expand section" : "Collapse section"}
          aria-expanded={!isCollapsed}
          onClick={() => ctx?.toggleCollapse(headingId)}
        >
          ▾
        </button>
      )}
      <span className="md-heading-text">{children}</span>
      {headingId && (
        <button
          type="button"
          className="md-heading-anchor"
          tabIndex={-1}
          aria-label="Copy link to this section"
          onClick={() => ctx?.onCopyAnchor(headingId)}
        >
          #
        </button>
      )}
    </Tag>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Count `\n` in a string (used for the frontmatter line offset). */
function countNewlines(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) n++;
  return n;
}

/** 1–6 if the element is a heading, else null. */
function headingLevel(el: Element): number | null {
  const m = /^H([1-6])$/.exec(el.tagName);
  return m ? Number(m[1]) : null;
}

/** Recursively gather text from a hast node (for the code-copy button). */
function hastToText(node: RmNode | undefined): string {
  if (!node) return "";
  const self = (node as { value?: string }).value ?? "";
  const kids = Array.isArray(node.children)
    ? node.children.map((c) => hastToText(c as RmNode)).join("")
    : "";
  return self + kids;
}

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
  // silently erased — micromark / remark-frontmatter / gray-matter all
  // share this failure mode because the token rule is purely fence-based.
  // We additionally require that the matched block contain at least one
  // YAML-key-looking line (`identifier:` at start of line, m-flag).
  // Real frontmatter always satisfies this; markdown bodies between two
  // `---` rarely do. On failure we leave the source intact, so the opening
  // `---` renders as a normal `<hr>` — same outcome as VS Code / remark-
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
