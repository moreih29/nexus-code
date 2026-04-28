import {
  DEFAULT_FILE,
  DEFAULT_FOLDER,
  DEFAULT_FOLDER_OPENED,
  getIconForFile,
  getIconForFolder,
  getIconForOpenFolder,
} from "vscode-icons-js";

export type FileIconKind = "file" | "folder";
export type FileIconFolderState = "open" | "closed";

export interface FileIconSourceRequest {
  name: string;
  kind: FileIconKind;
  folderState?: FileIconFolderState;
}

export interface FileIconSource {
  name: string;
  basename: string;
  kind: FileIconKind;
  folderState: FileIconFolderState | null;
  fileName: string;
  usesLibraryDefault: boolean;
}

export function resolveFileIconSource(request: FileIconSourceRequest): FileIconSource {
  const basename = basenameForIcon(request.name);

  if (request.kind === "folder") {
    const folderState = request.folderState ?? "closed";
    const fileName = folderState === "open" ? getIconForOpenFolder(basename) : getIconForFolder(basename);

    return {
      name: request.name,
      basename,
      kind: "folder",
      folderState,
      fileName,
      usesLibraryDefault: fileName === (folderState === "open" ? DEFAULT_FOLDER_OPENED : DEFAULT_FOLDER),
    };
  }

  const fileName = getIconForFile(basename) ?? DEFAULT_FILE;

  return {
    name: request.name,
    basename,
    kind: "file",
    folderState: null,
    fileName,
    usesLibraryDefault: fileName === DEFAULT_FILE,
  };
}

function basenameForIcon(name: string): string {
  const normalized = name.trim().replace(/\\/g, "/");
  const segments = normalized.split("/").filter(Boolean);
  return segments.at(-1) ?? normalized;
}
