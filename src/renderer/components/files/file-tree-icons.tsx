// File-type icon mapping for the file-tree row.
//
// Icons are pulled from lucide-react. The `File*` family is preferred
// over standalone glyphs (e.g. Code, Globe, Palette) because they share
// a common file-outline silhouette — the inner glyph hints type while
// the outer shape stays consistent across the tree, which keeps the
// dense list visually quiet (matches the "restraint through warmth"
// principle in .nexus/context/design.md).
//
// Color and stroke are applied at the call site (file-tree-row) so this
// module stays a pure mapping table.

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

// Exact-filename matches take precedence over extension lookup. Useful
// for the no-extension well-known names (`Dockerfile`, `Makefile`, ...).
const FILE_ICON_BY_NAME: Record<string, LucideIcon> = {
  Dockerfile: FileCog,
  Makefile: FileCog,
  LICENSE: FileText,
  README: FileText,
};

// Extension lookup. Keys include the leading dot so that dotfile names
// like `.env` and `.gitignore` resolve through the same path (their
// "extension" is the entire name, e.g. `.env` → `.env`).
const FILE_ICON_BY_EXT: Record<string, LucideIcon> = {
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
  // Markup / web — same File-Code silhouette since HTML/XML are
  // structured-as-code from a tooling perspective.
  ".html": FileCode,
  ".htm": FileCode,
  ".xml": FileCode,
  // Style — CSS-family files reuse FileCode silhouette to stay quiet;
  // lucide doesn't ship a palette-typed file glyph and `Palette` alone
  // would break the file-outline rhythm.
  ".css": FileCode,
  ".scss": FileCode,
  ".sass": FileCode,
  ".less": FileCode,
  // Shell scripts — terminal glyph reads as "executable text".
  ".sh": FileTerminal,
  ".bash": FileTerminal,
  ".zsh": FileTerminal,
  ".fish": FileTerminal,
  // Structured data — JSON gets its own `{ }` glyph for instant recognition.
  ".json": FileJson,
  ".jsonc": FileJson,
  // Config — gear glyph for the rest of the config family.
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
  // Lockfiles — covers `bun.lock`, `yarn.lock`, etc. via the `.lock`
  // suffix. `package-lock.json` has the `.json` ext and lands as
  // FileJson; that's a defensible call (it IS json) but if we want it
  // visually grouped with the lock family later, add it to BY_NAME.
  ".lock": FileLock,
};

/** Returns the lucide icon component to render for a file node. */
export function getFileIcon(name: string): LucideIcon {
  const byName = FILE_ICON_BY_NAME[name];
  if (byName) return byName;

  const dot = name.lastIndexOf(".");
  // No dot at all → unknown plain file.
  if (dot < 0) return File;

  // Includes the leading dot, e.g. ".tsx", ".env", ".gitignore".
  const ext = name.slice(dot).toLowerCase();
  return FILE_ICON_BY_EXT[ext] ?? File;
}

export const FOLDER_ICON: LucideIcon = Folder;
export const FOLDER_OPEN_ICON: LucideIcon = FolderOpen;
