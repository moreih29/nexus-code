// File-preview support detection.
//
// Used by EditorView to decide whether to mount the Raw/Preview toggle and
// which preview pane to dispatch to. Extension-based judgement is enough for
// v1 — content sniffing would be overkill for the four formats we render.
//
// .mdx is split out as `mdx-disabled` because v1 deliberately refuses to
// render MDX (JSX evaluation = arbitrary code execution from untrusted
// workspace content; see plan 60 issue 2). The toggle still renders as
// disabled with a tooltip explaining the reason, instead of silently
// disappearing — so the user knows why preview is unavailable.

export type PreviewSupport = "supported" | "mdx-disabled" | "none";

// Extensions react-markdown + remark-gfm handles. .markdown is the legacy
// long form still used in some repos (especially older GitHub READMEs).
const MARKDOWN_EXTENSIONS = [".md", ".markdown"] as const;
const HTML_EXTENSIONS = [".html", ".htm"] as const;
const SVG_EXTENSIONS = [".svg"] as const;
const MDX_EXTENSIONS = [".mdx"] as const;

/**
 * Returns the preview-mode disposition for a given file path.
 *
 * - "supported"     — render the toggle, preview pane is enabled.
 * - "mdx-disabled"  — render the toggle as disabled with a tooltip.
 * - "none"          — non-previewable, omit the toggle entirely.
 *
 * Match is case-insensitive on the trailing extension (`.MD`, `.Html`, etc.).
 */
export function isPreviewable(filePath: string): PreviewSupport {
  const lower = filePath.toLowerCase();
  if (MDX_EXTENSIONS.some((ext) => lower.endsWith(ext))) return "mdx-disabled";
  if (MARKDOWN_EXTENSIONS.some((ext) => lower.endsWith(ext))) return "supported";
  if (HTML_EXTENSIONS.some((ext) => lower.endsWith(ext))) return "supported";
  if (SVG_EXTENSIONS.some((ext) => lower.endsWith(ext))) return "supported";
  return "none";
}

export type PreviewEngine = "markdown" | "html" | "svg";

/**
 * Maps a supported file path to the concrete preview engine. Throws (never
 * called from runtime branches that have already filtered to "supported").
 * Used by EditorView's dispatcher.
 */
export function previewEngineFor(filePath: string): PreviewEngine {
  const lower = filePath.toLowerCase();
  if (MARKDOWN_EXTENSIONS.some((ext) => lower.endsWith(ext))) return "markdown";
  if (HTML_EXTENSIONS.some((ext) => lower.endsWith(ext))) return "html";
  if (SVG_EXTENSIONS.some((ext) => lower.endsWith(ext))) return "svg";
  throw new Error(`previewEngineFor called on non-previewable path: ${filePath}`);
}
