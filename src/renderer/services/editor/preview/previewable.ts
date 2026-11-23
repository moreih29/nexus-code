export type PreviewSupport = "supported" | "mdx-disabled" | "none";

const MARKDOWN_EXTENSIONS = [".md", ".markdown"] as const;
const HTML_EXTENSIONS = [".html", ".htm"] as const;
const SVG_EXTENSIONS = [".svg"] as const;
const TABLE_EXTENSIONS = [".csv", ".tsv"] as const;
const JSON_EXTENSIONS = [".json", ".jsonc"] as const;
const YAML_EXTENSIONS = [".yaml", ".yml"] as const;
const NOTEBOOK_EXTENSIONS = [".ipynb"] as const;
const MDX_EXTENSIONS = [".mdx"] as const;

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

export function isImageFile(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return IMAGE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

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

export type ViewMode = "raw" | "preview";

export type ViewModeDefaults = Readonly<Partial<Record<PreviewEngine, ViewMode>>>;

export function defaultViewMode(filePath: string, chosen: ViewModeDefaults = {}): ViewMode {
  if (isPreviewable(filePath) !== "supported") return "raw";
  const engine = previewEngineFor(filePath);
  return chosen[engine] ?? builtInViewMode(engine);
}

export function builtInViewMode(engine: PreviewEngine): ViewMode {
  return engine === "json" || engine === "yaml" ? "raw" : "preview";
}

export type PreviewEngine = "markdown" | "html" | "svg" | "table" | "json" | "yaml" | "notebook";

export const PREVIEW_FORMATS: readonly {
  readonly engine: PreviewEngine;
  readonly name: string;
  readonly extensions: readonly string[];
}[] = [
  { engine: "markdown", name: "Markdown", extensions: MARKDOWN_EXTENSIONS },
  { engine: "html", name: "HTML", extensions: HTML_EXTENSIONS },
  { engine: "svg", name: "SVG", extensions: SVG_EXTENSIONS },
  { engine: "table", name: "CSV · TSV", extensions: TABLE_EXTENSIONS },
  { engine: "json", name: "JSON", extensions: JSON_EXTENSIONS },
  { engine: "yaml", name: "YAML", extensions: YAML_EXTENSIONS },
  { engine: "notebook", name: "Jupyter Notebook", extensions: NOTEBOOK_EXTENSIONS },
];

export function isPreviewEngine(value: string): value is PreviewEngine {
  return PREVIEW_FORMATS.some((format) => format.engine === value);
}

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
