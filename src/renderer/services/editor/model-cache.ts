// Monaco TextModel reference counting.
// Mirrors VSCode ITextModelService — models are owned by the cache, not by editor instances.
// Framework-agnostic surface: acquire/release primitives, subscribeModel, isMonacoReady.
// React binding lives in `./use-shared-model.ts`.

import type * as Monaco from "monaco-editor";
import { absolutePathToFileUri, fileUriToAbsolutePath } from "../../../shared/file-uri";
import type { FileErrorCode } from "../../utils/file-error";
import {
  cleanupEntry,
  createEntry,
  errorCodeFromUnknown,
  type ModelEntry,
  snapshot,
  type SharedModelState,
} from "./model-entry";
import { initializeMonacoSingleton } from "./monaco-singleton";
export { isMonacoReady, onMonacoReady } from "./monaco-singleton";
export type { SharedModelPhase, SharedModelState } from "./model-entry";
import type { EditorInput } from "./types";

export function filePathToModelUri(filePath: string): string {
  return absolutePathToFileUri(filePath);
}

/**
 * Inverse of `filePathToModelUri`. Returns null when the cacheUri is not
 * one we produced (defensive — protects callers from mistakenly slicing
 * an unrelated string). Callers that need the file path of a tracked
 * model should always use this rather than slicing the prefix off
 * inline; the prefix shape is owned here.
 */
export function cacheUriToFilePath(cacheUri: string): string | null {
  return fileUriToAbsolutePath(cacheUri);
}

export function initializeModelCache(monaco: typeof Monaco): void {
  initializeMonacoSingleton(monaco);
}

const entries = new Map<string, ModelEntry>();

function cacheUriForInput(input: EditorInput): string {
  return filePathToModelUri(input.filePath);
}

/**
 * Subscribe to phase / model changes for a tracked entry. Returns a
 * no-op when the entry is unknown so callers don't need an extra
 * existence check. The unsubscribe returned removes the listener and
 * is idempotent.
 */
export function subscribeModel(input: EditorInput, onChange: () => void): () => void {
  const entry = entries.get(cacheUriForInput(input));
  if (!entry) return () => {};
  entry.subscribers.add(onChange);
  return () => {
    entry.subscribers.delete(onChange);
  };
}

/**
 * Read the current snapshot for a tracked entry, or null when no entry
 * exists. Pure read — does not affect ref-counts.
 */
export function getModelSnapshot(input: EditorInput): SharedModelState | null {
  const entry = entries.get(cacheUriForInput(input));
  return entry ? snapshot(entry) : null;
}

/**
 * Coerce an arbitrary thrown value to a FileErrorCode. Exposed for the
 * React binding so it can map a rejected acquire promise to the
 * `error` phase without re-implementing the heuristic.
 */
export function toFileErrorCode(error: unknown): FileErrorCode {
  return errorCodeFromUnknown(error);
}

export async function acquireModel(input: EditorInput): Promise<SharedModelState> {
  const cacheUri = cacheUriForInput(input);
  let entry = entries.get(cacheUri);
  if (!entry) {
    entry = createEntry(input, cacheUri);
    entries.set(cacheUri, entry);
  }

  entry.refCount += 1;
  await entry.loadPromise;
  return snapshot(entry);
}

export function releaseModel(input: EditorInput): void {
  const cacheUri = cacheUriForInput(input);
  const entry = entries.get(cacheUri);
  if (!entry) return;

  entry.refCount -= 1;
  if (entry.refCount > 0) return;

  entries.delete(cacheUri);
  cleanupEntry(entry);
}

/**
 * Read-only view of a resolved model entry. Exposed for the save-service
 * (and similar consumers) so they can act on a tracked model without
 * having to peek at the entry map directly.
 */
export interface ResolvedModelView {
  model: Monaco.editor.ITextModel;
  cacheUri: string;
  workspaceId: string;
  filePath: string;
  languageId: string;
}

export function getResolvedModel(input: EditorInput): ResolvedModelView | null {
  const entry = entries.get(cacheUriForInput(input));
  if (!entry || entry.phase !== "ready" || !entry.model) return null;
  return {
    model: entry.model,
    cacheUri: entry.cacheUri,
    workspaceId: entry.input.workspaceId,
    filePath: entry.input.filePath,
    languageId: entry.languageId,
  };
}
