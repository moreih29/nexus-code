/**
 * Pure resolver functions for file and folder icons.
 *
 * This module has NO Vite-specific imports (no SVG, no import.meta.glob),
 * so it can be imported and unit-tested in plain Bun/Node environments.
 *
 * Exported functions:
 *   - resolveLucide(kind, name)          → LucideIcon (always returns a value)
 *   - resolveMaterialIconName(kind, name) → string | null (iconName from manifest)
 *
 * The `<FileIcon>` component (file-icon.tsx) uses these functions alongside
 * the SVG import machinery that is Vite-only.
 */

import {
  File,
  FileArchive,
  FileCode,
  FileCog,
  FileImage,
  FileJson,
  FileLock,
  FileTerminal,
  FileText,
  Folder,
  FolderOpen,
  type LucideIcon,
} from "lucide-react";
import materialIconMap from "./material-icon-map.json";

// ---------------------------------------------------------------------------
// Types (re-exported for convenience)
// ---------------------------------------------------------------------------

export type FileIconKind = "file" | "folder" | "folder-open";

// ---------------------------------------------------------------------------
// Lucide resolver (minimal theme + fallback)
// ---------------------------------------------------------------------------

/** Exact-filename → lucide icon (highest priority). */
const LUCIDE_BY_NAME: Record<string, LucideIcon> = {
  Dockerfile: FileCog,
  Makefile: FileCog,
  LICENSE: FileText,
  README: FileText,
};

/**
 * Extension → lucide icon. Keys include the leading dot so that dotfiles
 * such as `.env` and `.gitignore` resolve through the same path.
 */
const LUCIDE_BY_EXT: Record<string, LucideIcon> = {
  // Code — programming languages.
  ".ts": FileCode,
  ".tsx": FileCode,
  ".js": FileCode,
  ".jsx": FileCode,
  ".mjs": FileCode,
  ".cjs": FileCode,
  ".py": FileCode,
  ".pyi": FileCode,
  ".go": FileCode,
  ".rs": FileCode,
  ".java": FileCode,
  ".kt": FileCode,
  ".scala": FileCode,
  ".swift": FileCode,
  ".rb": FileCode,
  ".php": FileCode,
  ".c": FileCode,
  ".h": FileCode,
  ".cpp": FileCode,
  ".cc": FileCode,
  ".hpp": FileCode,
  ".dart": FileCode,
  ".lua": FileCode,
  ".sql": FileCode,
  ".vue": FileCode,
  ".svelte": FileCode,
  // Markup / web.
  ".html": FileCode,
  ".htm": FileCode,
  ".xml": FileCode,
  // Style.
  ".css": FileCode,
  ".scss": FileCode,
  ".sass": FileCode,
  ".less": FileCode,
  // Shell scripts.
  ".sh": FileTerminal,
  ".bash": FileTerminal,
  ".zsh": FileTerminal,
  ".fish": FileTerminal,
  // Structured data.
  ".json": FileJson,
  ".jsonc": FileJson,
  // Config.
  ".yaml": FileCog,
  ".yml": FileCog,
  ".toml": FileCog,
  ".ini": FileCog,
  ".env": FileCog,
  ".conf": FileCog,
  ".gitignore": FileCog,
  ".gitattributes": FileCog,
  ".dockerignore": FileCog,
  ".npmrc": FileCog,
  ".nvmrc": FileCog,
  ".prettierrc": FileCog,
  ".eslintrc": FileCog,
  ".editorconfig": FileCog,
  // Text / docs.
  ".md": FileText,
  ".markdown": FileText,
  ".mdx": FileText,
  ".txt": FileText,
  ".rst": FileText,
  ".log": FileText,
  // Images.
  ".png": FileImage,
  ".jpg": FileImage,
  ".jpeg": FileImage,
  ".gif": FileImage,
  ".svg": FileImage,
  ".webp": FileImage,
  ".ico": FileImage,
  ".bmp": FileImage,
  ".avif": FileImage,
  // Archives.
  ".zip": FileArchive,
  ".tar": FileArchive,
  ".gz": FileArchive,
  ".tgz": FileArchive,
  ".bz2": FileArchive,
  ".7z": FileArchive,
  ".rar": FileArchive,
  // Lockfiles.
  ".lock": FileLock,
};

/**
 * Resolves the Lucide icon for a given node kind and filename.
 * Pure function — no React, no store, no dynamic imports.
 *
 * @param kind - "file" | "folder" | "folder-open"
 * @param name - filename (required when kind="file"; ignored otherwise)
 */
export function resolveLucide(kind: FileIconKind, name?: string): LucideIcon {
  if (kind === "folder") return Folder;
  if (kind === "folder-open") return FolderOpen;

  // kind === "file"
  const fileName = name ?? "";

  const byName = LUCIDE_BY_NAME[fileName];
  if (byName) return byName;

  const dot = fileName.lastIndexOf(".");
  if (dot < 0) return File;

  const ext = fileName.slice(dot).toLowerCase();
  return LUCIDE_BY_EXT[ext] ?? File;
}

// ---------------------------------------------------------------------------
// Material icon name resolver (theme=material → iconName from manifest)
// ---------------------------------------------------------------------------

type MaterialIconMap = typeof materialIconMap;

const MAP_EXT = (materialIconMap as MaterialIconMap).ext as Record<string, string>;
const MAP_FILE = (materialIconMap as MaterialIconMap).file as Record<string, string>;
const MAP_FOLDER =
  (
    materialIconMap as MaterialIconMap & {
      folder?: Record<string, string>;
    }
  ).folder ?? {};
const MAP_FOLDER_OPEN =
  (
    materialIconMap as MaterialIconMap & {
      folderOpen?: Record<string, string>;
    }
  ).folderOpen ?? {};
const FILE_DEFAULT =
  (materialIconMap as MaterialIconMap & { fileDefault?: string }).fileDefault ?? "file";
const FOLDER_DEFAULT = (materialIconMap as MaterialIconMap).folderDefault;
const FOLDER_OPEN_DEFAULT = (materialIconMap as MaterialIconMap).folderOpenDefault;

/**
 * Resolves the material icon name (manifest string key) for a given node.
 * Pure function — no React, no store, no dynamic imports.
 *
 * Returns the iconName string (e.g. "typescript", "react_ts", "folder"), or
 * null if the manifest has no entry (caller should fall back to Lucide).
 *
 * Resolution order for files:
 *   1. Exact lowercase filename match in manifest `file` map.
 *   2. Longest multi-segment suffix (e.g. "d.ts" before "ts") in `ext` map.
 *   3. fileDefault ("file").
 */
export function resolveMaterialIconName(kind: FileIconKind, name?: string): string | null {
  if (kind === "folder") {
    const key = (name ?? "").toLowerCase();
    return MAP_FOLDER[key] ?? FOLDER_DEFAULT ?? null;
  }
  if (kind === "folder-open") {
    const key = (name ?? "").toLowerCase();
    return MAP_FOLDER_OPEN[key] ?? FOLDER_OPEN_DEFAULT ?? null;
  }

  // kind === "file"
  const fileName = name ?? "";
  const lowerName = fileName.toLowerCase();

  // 1. Exact filename match (case-insensitive).
  if (lowerName in MAP_FILE) return MAP_FILE[lowerName];

  // 2. Multi-segment suffix match — walk every dot position left-to-right
  //    so longer suffixes (closer to the start) are tested first.
  //    Example: "foo.d.ts" → tests "d.ts" before "ts".
  let dotIdx = lowerName.indexOf(".");
  while (dotIdx >= 0) {
    const suffix = lowerName.slice(dotIdx + 1); // without the leading dot
    if (suffix in MAP_EXT) return MAP_EXT[suffix];
    dotIdx = lowerName.indexOf(".", dotIdx + 1);
  }

  // 3. fileDefault
  return FILE_DEFAULT;
}
