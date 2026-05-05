// Save transaction orchestrator.
//
// Composes:
//   - SaveSequentializer (per-file in-flight gate, supersession)
//   - dirty-tracker     (alt versionId baseline + loaded mtime/size)
//   - model-cache       (read-only model view)
//   - fs.writeFile IPC  (atomic write with mtime/size guard)
//
// One public function: saveModel(input). Result is a discriminated union
// so callers (Cmd+S handler, close-handler, save participants) decide
// what to do with conflict/error without re-implementing the dispatch.

import { ipcCall } from "../../ipc/client";
import { getDirtyEntry, markSaved as markDirtyTrackerSaved } from "./dirty-tracker";
import { relPathForInput } from "./file-loader";
import { getResolvedModel } from "./model-cache";
import { promoteAllPreviewTabsForFile } from "./promote-policy";
import { SaveSequentializer, SaveSupersededError } from "./save-sequentializer";
import type { EditorInput } from "./types";

export type SaveResult =
  | { kind: "saved"; mtime: string; size: number }
  | { kind: "not-dirty" }
  | { kind: "no-model" }
  | { kind: "conflict"; actual: { exists: false } | { exists: true; mtime: string; size: number } }
  | { kind: "superseded" }
  | { kind: "error"; message: string };

const sequentializer = new SaveSequentializer();

/**
 * Persist the buffer for `input` to disk. Safe to invoke concurrently:
 * a second call for the same file while the first is in-flight will
 * abort the first (which keeps writing in the background but its result
 * is discarded) and run with the latest content. The earlier caller
 * receives `{ kind: 'superseded' }`.
 */
export async function saveModel(input: EditorInput): Promise<SaveResult> {
  const resolved = getResolvedModel(input);
  if (!resolved) return { kind: "no-model" };

  // VSCode parity: an explicit save promotes the editor regardless of
  // dirty state. editorService.save() pinEditor's the editor on
  // SaveReason.EXPLICIT before invoking the model's save. saveModel is
  // only called from explicit user gestures (Cmd+S, close-confirm), so
  // every entry counts as EXPLICIT.
  promoteAllPreviewTabsForFile(resolved.filePath);

  const dirtyEntry = getDirtyEntry(resolved.cacheUri);
  if (!dirtyEntry) return { kind: "no-model" };

  if (!dirtyEntry.isDirty) return { kind: "not-dirty" };

  try {
    return await sequentializer.run(resolved.cacheUri, async () => {
      // Re-read the entry inside the gate — by the time we got here the
      // user could have undone back to the saved baseline (dirty=false).
      const dirtyEntryNow = getDirtyEntry(resolved.cacheUri);
      if (!dirtyEntryNow?.isDirty) {
        return { kind: "not-dirty" } satisfies SaveResult;
      }

      // Snapshot the alt id at the moment we capture content. If the
      // user keeps typing during the IPC roundtrip, this captured value
      // is what we'll mark as "saved" — markSaved then re-evaluates
      // dirty against the current alt id.
      const capturedAltId = resolved.model.getAlternativeVersionId();
      const content = resolved.model.getValue();
      const expected =
        dirtyEntryNow.loadedMtime === ""
          ? ({ exists: false } as const)
          : ({
              exists: true,
              mtime: dirtyEntryNow.loadedMtime,
              size: dirtyEntryNow.loadedSize,
            } as const);

      const ipcResult = await ipcCall("fs", "writeFile", {
        workspaceId: resolved.workspaceId,
        relPath: relPathForInput({
          workspaceId: resolved.workspaceId,
          filePath: resolved.filePath,
        }),
        content,
        expected,
      });

      if (ipcResult.kind === "conflict") {
        // No mutation to dirty/baseline — caller will reload or force.
        return { kind: "conflict", actual: ipcResult.actual } satisfies SaveResult;
      }

      markDirtyTrackerSaved({
        cacheUri: resolved.cacheUri,
        model: resolved.model,
        savedAlternativeVersionId: capturedAltId,
        loadedMtime: ipcResult.mtime,
        loadedSize: ipcResult.size,
      });

      return { kind: "saved", mtime: ipcResult.mtime, size: ipcResult.size } satisfies SaveResult;
    });
  } catch (e) {
    if (e instanceof SaveSupersededError) {
      return { kind: "superseded" };
    }
    const message = e instanceof Error ? e.message : String(e);
    return { kind: "error", message };
  }
}
