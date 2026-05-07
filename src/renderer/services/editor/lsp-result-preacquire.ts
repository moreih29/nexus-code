// Pre-acquire monaco models for cross-file LSP result URIs (definition,
// references) before returning them to monaco. Without this, monaco's peek
// widget calls `ITextModelService.createModelReference(uri)` on each result
// to render an inline preview, and standalone monaco's default text-model
// service throws "Model not found" because we have not yet created models
// for those URIs (our model-cache only fires on app-level acquireModel).
//
// Strategy:
//   1. Inspect each result Location, derive an EditorInput
//      (workspace vs external is decided by isWithinWorkspace against the
//      source workspace's root).
//   2. Await acquireModel for all results in parallel. By the time the
//      provider returns, models exist in monaco's registry.
//   3. Schedule a release after PEEK_PREACQUIRE_HOLD_MS. The hold window
//      is long enough for peek to render and (if the user navigates) for
//      the opener's own acquireModel to take a real reference. Short
//      enough that an unused pre-acquire releases promptly.
//
// Dependency injection: production callers use {@link defaultPreAcquireDeps}
// implicitly (param defaulted). Tests pass their own deps map to avoid
// process-global mock.module pollution of model-cache exports — Bun's
// `mock.module` replaces modules across all test files in the same
// process, so we deliberately keep production-side mocks limited to
// shared modules whose exports are stable.
//
// Long-term, this whole module becomes unnecessary once we migrate to
// monaco-vscode-api with an IFileService overlay (separate effort).

import type * as Monaco from "monaco-editor";
import { useWorkspacesStore } from "../../state/stores/workspaces";
import { isWithinWorkspace } from "../../utils/path";
import {
  acquireModel,
  cacheUriToFilePath,
  type EntryMetadata,
  getEntryMetadata,
  releaseModel,
} from "./model-cache";
import type { EditorInput } from "./types";

/**
 * How long pre-acquired models are held before scheduled release.
 * Exposed for tests (override via fake timers).
 */
export const PEEK_PREACQUIRE_HOLD_MS = 30_000;

export interface PreAcquireDeps {
  acquireModel: (input: EditorInput) => Promise<unknown>;
  releaseModel: (input: EditorInput) => void;
  getEntryMetadata: (cacheUri: string) => EntryMetadata | null;
  workspaceRootForId: (workspaceId: string) => string | null;
}

export const defaultPreAcquireDeps: PreAcquireDeps = {
  acquireModel,
  releaseModel,
  getEntryMetadata,
  workspaceRootForId(workspaceId) {
    const ws = useWorkspacesStore.getState().workspaces.find((w) => w.id === workspaceId);
    return ws?.rootPath ?? null;
  },
};

function inputForLocation(
  filePath: string,
  workspaceId: string,
  workspaceRoot: string | null,
): EditorInput {
  if (workspaceRoot !== null && isWithinWorkspace(filePath, workspaceRoot)) {
    return { workspaceId, filePath };
  }
  // Outside workspace → external read-only (mirrors the opener's branch in
  // editor-view.tsx so the same file resolves to the same ModelEntry whether
  // pre-acquire or the opener creates it first).
  return { workspaceId, filePath, origin: "external", readOnly: true };
}

/**
 * Pre-acquire monaco models for cross-file LSP result locations.
 *
 * @param locations Result locations from a definition / references provider.
 * @param sourceCacheUri The `model.uri.toString()` of the model that fired
 *        the provider. Used to look up the source workspace and to filter
 *        out self-references.
 * @param deps Injectable dependency map (defaults to production deps).
 */
export async function preAcquireLocationModels(
  locations: readonly Monaco.languages.Location[],
  sourceCacheUri: string,
  deps: PreAcquireDeps = defaultPreAcquireDeps,
): Promise<void> {
  if (locations.length === 0) return;

  const sourceMeta = deps.getEntryMetadata(sourceCacheUri);
  if (!sourceMeta) return;

  const { workspaceId } = sourceMeta;
  const workspaceRoot = deps.workspaceRootForId(workspaceId);

  // Dedupe by absolute path. A single LSP query can return multiple ranges
  // in the same file (e.g., a re-export pointing to both `class Path` and
  // its `__all__` entry); we only need to load each path once.
  const seenPaths = new Set<string>();
  const inputs: EditorInput[] = [];

  for (const location of locations) {
    const targetUri = location.uri.toString();
    if (targetUri === sourceCacheUri) continue;

    const filePath = cacheUriToFilePath(targetUri);
    if (filePath === null) continue;
    if (seenPaths.has(filePath)) continue;
    seenPaths.add(filePath);

    inputs.push(inputForLocation(filePath, workspaceId, workspaceRoot));
  }

  await Promise.all(
    inputs.map(async (input) => {
      try {
        await deps.acquireModel(input);
        scheduleRelease(input, deps.releaseModel);
      } catch {
        // Pre-acquire is best-effort. A failed load (missing file, EACCES,
        // etc.) leaves the entry in an error phase; peek will show the row
        // without inline preview rather than throwing.
      }
    }),
  );
}

function scheduleRelease(input: EditorInput, release: PreAcquireDeps["releaseModel"]): void {
  setTimeout(() => {
    try {
      release(input);
    } catch {
      // Defensive — entry may have been force-disposed by a workspace
      // close that fired between pre-acquire and the scheduled release.
    }
  }, PEEK_PREACQUIRE_HOLD_MS);
}
