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

export type FileIconKind = "file" | "folder" | "folder-open";

const LUCIDE_BY_NAME: Record<string, LucideIcon> = {
  Dockerfile: FileCog,
  Makefile: FileCog,
  LICENSE: FileText,
  README: FileText,
};

const LUCIDE_BY_EXT: Record<string, LucideIcon> = {
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
  ".html": FileCode,
  ".htm": FileCode,
  ".xml": FileCode,
  ".css": FileCode,
  ".scss": FileCode,
  ".sass": FileCode,
  ".less": FileCode,
  ".sh": FileTerminal,
  ".bash": FileTerminal,
  ".zsh": FileTerminal,
  ".fish": FileTerminal,
  ".json": FileJson,
  ".jsonc": FileJson,
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
  ".md": FileText,
  ".markdown": FileText,
  ".mdx": FileText,
  ".txt": FileText,
  ".rst": FileText,
  ".log": FileText,
  ".png": FileImage,
  ".jpg": FileImage,
  ".jpeg": FileImage,
  ".gif": FileImage,
  ".svg": FileImage,
  ".webp": FileImage,
  ".ico": FileImage,
  ".bmp": FileImage,
  ".avif": FileImage,
  ".zip": FileArchive,
  ".tar": FileArchive,
  ".gz": FileArchive,
  ".tgz": FileArchive,
  ".bz2": FileArchive,
  ".7z": FileArchive,
  ".rar": FileArchive,
  ".lock": FileLock,
};

export function resolveLucide(kind: FileIconKind, name?: string): LucideIcon {
  if (kind === "folder") return Folder;
  if (kind === "folder-open") return FolderOpen;

  const fileName = name ?? "";

  const byName = LUCIDE_BY_NAME[fileName];
  if (byName) return byName;

  const dot = fileName.lastIndexOf(".");
  if (dot < 0) return File;

  const ext = fileName.slice(dot).toLowerCase();
  return LUCIDE_BY_EXT[ext] ?? File;
}

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

export function resolveMaterialIconName(kind: FileIconKind, name?: string): string | null {
  if (kind === "folder") {
    const key = (name ?? "").toLowerCase();
    return MAP_FOLDER[key] ?? FOLDER_DEFAULT ?? null;
  }
  if (kind === "folder-open") {
    const key = (name ?? "").toLowerCase();
    return MAP_FOLDER_OPEN[key] ?? FOLDER_OPEN_DEFAULT ?? null;
  }

  const fileName = name ?? "";
  const lowerName = fileName.toLowerCase();

  if (lowerName in MAP_FILE) return MAP_FILE[lowerName];

  let dotIdx = lowerName.indexOf(".");
  while (dotIdx >= 0) {
    const suffix = lowerName.slice(dotIdx + 1);
    if (suffix in MAP_EXT) return MAP_EXT[suffix];
    dotIdx = lowerName.indexOf(".", dotIdx + 1);
  }

  return FILE_DEFAULT;
}
