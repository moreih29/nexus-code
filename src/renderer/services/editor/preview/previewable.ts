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
// Delimited values, shown as a table.
const TABLE_EXTENSIONS = [".csv", ".tsv"] as const;
// JSON, shown as a tree. Comments are taken, as configuration files have.
const JSON_EXTENSIONS = [".json", ".jsonc"] as const;
// YAML, shown as the same tree.
const YAML_EXTENSIONS = [".yaml", ".yml"] as const;
// Jupyter notebooks, shown as their cells and outputs.
const NOTEBOOK_EXTENSIONS = [".ipynb"] as const;
const MDX_EXTENSIONS = [".mdx"] as const;

// Raster image formats the renderer can display via the `nexus-workspace://`
// custom protocol. `.svg` is intentionally excluded here — SVG already has
// its own raw/preview toggle (text source ↔ blob-URL render), so it stays
// on the text editor track. The remaining formats are pure binary; opening
// them in Monaco would only show the bytes-rejected message.
const IMAGE_EXTENSIONS = [
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".bmp",
  ".ico",
  ".avif",
] as const;

/**
 * Returns true when the file's extension identifies a raster image format
 * that the dedicated image viewer (not Monaco) should render.
 *
 * Match is case-insensitive on the trailing extension.
 */
export function isImageFile(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return IMAGE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

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
  if (TABLE_EXTENSIONS.some((ext) => lower.endsWith(ext))) return "supported";
  if (JSON_EXTENSIONS.some((ext) => lower.endsWith(ext))) return "supported";
  if (YAML_EXTENSIONS.some((ext) => lower.endsWith(ext))) return "supported";
  if (NOTEBOOK_EXTENSIONS.some((ext) => lower.endsWith(ext))) return "supported";
  return "none";
}

/**
 * How a file opens: in its preview when it has one, in its source otherwise.
 * JSON and YAML open in their source, which is what they are mostly
 * opened to read and change; their tree is a switch away. A tab keeps the mode it was switched
 * to; this is the mode of one never switched.
 */
export function defaultViewMode(filePath: string): "raw" | "preview" {
  if (isPreviewable(filePath) !== "supported") return "raw";
  const engine = previewEngineFor(filePath);
  return engine === "json" || engine === "yaml" ? "raw" : "preview";
}

export type PreviewEngine = "markdown" | "html" | "svg" | "table" | "json" | "yaml" | "notebook";

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
  if (TABLE_EXTENSIONS.some((ext) => lower.endsWith(ext))) return "table";
  if (JSON_EXTENSIONS.some((ext) => lower.endsWith(ext))) return "json";
  if (YAML_EXTENSIONS.some((ext) => lower.endsWith(ext))) return "yaml";
  if (NOTEBOOK_EXTENSIONS.some((ext) => lower.endsWith(ext))) return "notebook";
  throw new Error(`previewEngineFor called on non-previewable path: ${filePath}`);
}
