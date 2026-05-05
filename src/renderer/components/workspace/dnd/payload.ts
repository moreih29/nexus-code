/**
 * Pure DataTransfer payload parsing.
 *
 * Both group-level and tab-bar-level drop targets need to inspect the
 * dataTransfer to discriminate between a tab move and a file open. The
 * parsing is identical and benefits from being a single point of truth —
 * a malformed JSON in either MIME slot must yield `null` consistently so
 * neither target can drop garbage into operations.
 *
 * `hasSupportedMime` is the dragenter/dragover gate: dataTransfer.types
 * is exposed before drop (the data itself is not, for cross-window
 * security), so we can decide whether to even respond to the drag based
 * on MIME alone.
 */
import {
  type FileDragPayload,
  MIME_FILE,
  MIME_TAB,
  type TabDragPayload,
} from "./types";

export type ParsedDragPayload =
  | { kind: "tab"; payload: TabDragPayload }
  | { kind: "file"; payload: FileDragPayload };

export function parseDragPayload(dt: DataTransfer): ParsedDragPayload | null {
  const tabRaw = dt.getData(MIME_TAB);
  if (tabRaw) {
    try {
      return { kind: "tab", payload: JSON.parse(tabRaw) as TabDragPayload };
    } catch {
      return null;
    }
  }
  const fileRaw = dt.getData(MIME_FILE);
  if (fileRaw) {
    try {
      return { kind: "file", payload: JSON.parse(fileRaw) as FileDragPayload };
    } catch {
      return null;
    }
  }
  return null;
}

export function hasSupportedMime(types: ReadonlyArray<string>): boolean {
  return types.includes(MIME_TAB) || types.includes(MIME_FILE);
}
