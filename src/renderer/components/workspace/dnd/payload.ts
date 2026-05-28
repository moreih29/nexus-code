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
 *
 * Phase E: adds `buildFileDragPayload` and `parseFileDragPayload` with
 * validated multi-path payload.  `parseDragPayload` is updated to use the
 * new `filePaths` shape while remaining backward-compatible for tab payloads.
 */
import { type FileDragPayload, MIME_FILE, MIME_TAB, type TabDragPayload } from "./types";

export type ParsedDragPayload =
  | { kind: "tab"; payload: TabDragPayload }
  | { kind: "file"; payload: FileDragPayload };

// ---------------------------------------------------------------------------
// buildFileDragPayload
// ---------------------------------------------------------------------------

/**
 * Construct a validated `FileDragPayload`.
 *
 * @throws `Error` when `filePaths` is empty (invariant violation).
 */
export function buildFileDragPayload(
  workspaceId: string,
  filePaths: readonly string[],
): FileDragPayload {
  if (filePaths.length === 0) {
    throw new Error("buildFileDragPayload: filePaths must be non-empty");
  }
  return { workspaceId, filePaths };
}

// ---------------------------------------------------------------------------
// parseFileDragPayload
// ---------------------------------------------------------------------------

/**
 * Parse a `FileDragPayload` from a drop event's DataTransfer.
 *
 * Returns `null` when:
 *   - `MIME_FILE` is absent.
 *   - JSON is malformed.
 *   - Parsed shape fails invariants (`filePaths` missing or empty, any entry
 *     not a string, `workspaceId` not a string).
 */
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

// ---------------------------------------------------------------------------
// parseDragPayload — union parser (tab + file)
// ---------------------------------------------------------------------------

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
