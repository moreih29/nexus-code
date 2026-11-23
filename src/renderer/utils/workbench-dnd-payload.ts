import {
  type FileDragPayload,
  MIME_FILE,
  MIME_TAB,
  type TabDragPayload,
} from "../types/workbench-dnd";

export type ParsedDragPayload =
  | { kind: "tab"; payload: TabDragPayload }
  | { kind: "file"; payload: FileDragPayload };

export function buildFileDragPayload(
  workspaceId: string,
  filePaths: readonly string[],
): FileDragPayload {
  if (filePaths.length === 0) {
    throw new Error("buildFileDragPayload: filePaths must be non-empty");
  }
  return { workspaceId, filePaths };
}

export function parseFileDragPayload(dt: DataTransfer): FileDragPayload | null {
  try {
    const raw = dt.getData(MIME_FILE);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed.workspaceId !== "string") return null;
    if (!Array.isArray(parsed.filePaths) || parsed.filePaths.length === 0) return null;
    if (!parsed.filePaths.every((p: unknown) => typeof p === "string")) return null;
    return { workspaceId: parsed.workspaceId, filePaths: parsed.filePaths as string[] };
  } catch {
    return null;
  }
}

export function parseDragPayload(dt: DataTransfer): ParsedDragPayload | null {
  const tabRaw = dt.getData(MIME_TAB);
  if (tabRaw) {
    try {
      return { kind: "tab", payload: JSON.parse(tabRaw) as TabDragPayload };
    } catch {
      return null;
    }
  }
  const fileParsed = parseFileDragPayload(dt);
  if (fileParsed) {
    return { kind: "file", payload: fileParsed };
  }
  return null;
}

export function hasSupportedMime(types: ReadonlyArray<string>): boolean {
  return types.includes(MIME_TAB) || types.includes(MIME_FILE);
}
