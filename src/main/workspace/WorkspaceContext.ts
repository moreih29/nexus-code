import type { WorkspaceMeta } from "../../shared/types/workspace";
import type { WorkspaceStorage } from "../storage/workspaceStorage";

// ---------------------------------------------------------------------------
// WorkspaceContext — one instance per open workspace.
// Holds a reference to the per-workspace storage handle and the in-memory
// cached meta. M0: tabs are not persisted (M1).
// ---------------------------------------------------------------------------

export class WorkspaceContext {
  private meta: WorkspaceMeta;
  private readonly storage: WorkspaceStorage;

  constructor(meta: WorkspaceMeta, storage: WorkspaceStorage) {
    this.meta = meta;
    this.storage = storage;
  }

  getMeta(): WorkspaceMeta {
    return this.meta;
  }

  setMeta(updated: WorkspaceMeta): void {
    this.meta = updated;
    this.storage.setMeta(updated.id, updated);
  }

  close(): void {
    this.storage.closeForWorkspace(this.meta.id);
  }
}
