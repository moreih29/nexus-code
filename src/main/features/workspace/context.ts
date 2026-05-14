import type { WorkspaceMeta } from "../../../shared/types/workspace";
import type { FsProvider } from "../fs/bridge/provider";
import type { WorkspaceStorage } from "../../storage/workspace-storage";

// ---------------------------------------------------------------------------
// WorkspaceContext — one instance per open workspace.
// Holds a reference to the per-workspace storage handle and the in-memory
// cached meta. Tab layout/session persistence is handled outside this context.
// ---------------------------------------------------------------------------

export class WorkspaceContext {
  private meta: WorkspaceMeta;
  private readonly storage: WorkspaceStorage;
  private fsProvider: FsProvider;
  private disposeFsProvider: (() => void) | undefined;

  constructor(meta: WorkspaceMeta, storage: WorkspaceStorage, fs: FsProvider) {
    this.meta = meta;
    this.storage = storage;
    this.fsProvider = fs;
  }

  get fs(): FsProvider {
    return this.fsProvider;
  }

  getMeta(): WorkspaceMeta {
    return this.meta;
  }

  setMeta(updated: WorkspaceMeta): void {
    this.meta = updated;
    this.storage.setMeta(updated.id, updated);
  }

  /**
   * Replaces the active filesystem provider and disposes provider-owned state.
   */
  setFsProvider(fs: FsProvider, dispose?: () => void): void {
    this.disposeCurrentFsProvider();
    this.fsProvider = fs;
    this.disposeFsProvider = dispose;
  }

  close(): void {
    this.disposeCurrentFsProvider();
    this.disposeFsProvider = undefined;
    this.storage.closeForWorkspace(this.meta.id);
  }

  private disposeCurrentFsProvider(): void {
    this.disposeFsProvider?.();
    if (!this.disposeFsProvider) {
      this.fsProvider.dispose?.();
    }
  }
}
