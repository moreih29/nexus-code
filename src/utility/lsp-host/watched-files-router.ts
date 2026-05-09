/**
 * Watched-files router — translates `fsChanged` IPC notifications into
 * `workspace/didChangeWatchedFiles` LSP notifications.
 *
 * Receives raw `fsChanged` payloads from the main process, validates them,
 * converts relative paths to absolute `file://` URIs, and dispatches to every
 * adapter in the affected workspace that has registered at least one
 * `didChangeWatchedFiles` capability.  Also resets the idle timer for each
 * adapter that receives changes so that file-system activity counts as usage.
 */

import path from "node:path";
import { absolutePathToFileUri } from "../../shared/file-uri";
import { FsChangedArgsSchema, fsChangeKindToLspType } from "./lsp-handlers";
import type { AdapterRegistry } from "./adapter-registry";

// ---------------------------------------------------------------------------
// WatchedFilesRouter
// ---------------------------------------------------------------------------

export class WatchedFilesRouter {
  constructor(private readonly registry: AdapterRegistry) {}

  /**
   * Handle a raw `fsChanged` notification payload.  Silently ignores payloads
   * that do not parse or workspaces with no registered adapters.
   */
  handleFsChanged(params: unknown): void {
    const parsed = FsChangedArgsSchema.safeParse(params);
    if (!parsed.success) return;

    const { workspaceId, changes } = parsed.data;
    const workspaceAdapters = this.registry.adapters.get(workspaceId);
    const workspaceRegistrations = this.registry.watchedFileRegistrations.get(workspaceId);
    const workspaceRoot = this.registry.workspaceRoots.get(workspaceId);
    if (!workspaceAdapters || !workspaceRegistrations || !workspaceRoot) return;

    const lspChanges = changes.map((change) => ({
      uri: absolutePathToFileUri(path.join(workspaceRoot, change.relPath)),
      type: fsChangeKindToLspType(change.kind),
    }));
    if (lspChanges.length === 0) return;

    for (const [presetLanguageId, adapter] of workspaceAdapters) {
      const registrations = workspaceRegistrations.get(presetLanguageId);
      if (!registrations || registrations.length === 0) continue;

      adapter.notify("workspace/didChangeWatchedFiles", { changes: lspChanges });
      this.registry.resetIdleTimer(workspaceId, presetLanguageId);
    }
  }
}
