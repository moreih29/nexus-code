import { randomUUID } from "node:crypto";
import path from "node:path";
import type { WorkspaceMeta } from "../../shared/types/workspace";
import type { GlobalStorage } from "../storage/globalStorage";
import type { StateService } from "../storage/stateService";
import type { WorkspaceStorage } from "../storage/workspaceStorage";
import { WorkspaceContext } from "./WorkspaceContext";

// ---------------------------------------------------------------------------
// Broadcast callback type — injected so the manager has no hard import on
// Electron and can be tested without a live renderer process.
// ---------------------------------------------------------------------------

export type BroadcastFn = (channelName: string, event: string, args: unknown) => void;

// ---------------------------------------------------------------------------
// WorkspaceManager — global singleton, created once in main/index.ts.
// ---------------------------------------------------------------------------

export class WorkspaceManager {
  private readonly globalStorage: GlobalStorage;
  private readonly workspaceStorage: WorkspaceStorage;
  private readonly stateService: StateService;
  private readonly broadcastFn: BroadcastFn;

  private readonly contexts = new Map<string, WorkspaceContext>();
  private activeId: string | null = null;

  constructor(
    globalStorage: GlobalStorage,
    workspaceStorage: WorkspaceStorage,
    stateService: StateService,
    broadcastFn: BroadcastFn,
  ) {
    this.globalStorage = globalStorage;
    this.workspaceStorage = workspaceStorage;
    this.stateService = stateService;
    this.broadcastFn = broadcastFn;
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Load all persisted workspaces into memory and restore the active workspace.
   * Call once after app.whenReady().
   */
  init(): void {
    const metas = this.globalStorage.listWorkspaces();
    for (const meta of metas) {
      this.workspaceStorage.openForWorkspace(meta.id);
      const ctx = new WorkspaceContext(meta, this.workspaceStorage);
      this.contexts.set(meta.id, ctx);
    }

    const savedId = this.stateService.getState().lastActiveWorkspaceId;
    if (savedId && this.contexts.has(savedId)) {
      this.activeId = savedId;
    } else if (metas.length > 0) {
      this.activeId = metas[0].id;
      this.stateService.setState({ lastActiveWorkspaceId: this.activeId });
    }
  }

  /**
   * Close all open workspace storage handles and the global storage.
   * Call from app.on('before-quit').
   */
  close(): void {
    for (const [id, ctx] of this.contexts) {
      ctx.close();
      this.contexts.delete(id);
    }
    this.globalStorage.close();
  }

  // ---------------------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------------------

  list(): WorkspaceMeta[] {
    return Array.from(this.contexts.values()).map((ctx) => ctx.getMeta());
  }

  getActiveId(): string | null {
    return this.activeId;
  }

  // ---------------------------------------------------------------------------
  // Mutations
  // ---------------------------------------------------------------------------

  create(opts: { rootPath: string; name?: string }): WorkspaceMeta {
    const id = randomUUID();
    const name = opts.name ?? path.basename(opts.rootPath);
    const meta: WorkspaceMeta = {
      id,
      name,
      rootPath: opts.rootPath,
      colorTone: "default",
      pinned: false,
      lastOpenedAt: new Date().toISOString(),
      tabs: [],
    };

    this.globalStorage.addWorkspace(meta);
    this.workspaceStorage.openForWorkspace(id);
    const ctx = new WorkspaceContext(meta, this.workspaceStorage);
    ctx.setMeta(meta);
    this.contexts.set(id, ctx);

    this.broadcastFn("workspace", "changed", meta);
    return meta;
  }

  update(id: string, partial: Partial<Omit<WorkspaceMeta, "id" | "tabs">>): WorkspaceMeta {
    const ctx = this.contexts.get(id);
    if (!ctx) {
      throw new Error(`workspace not found: ${id}`);
    }
    this.globalStorage.updateWorkspace(id, partial);
    const updated: WorkspaceMeta = { ...ctx.getMeta(), ...partial };
    ctx.setMeta(updated);

    this.broadcastFn("workspace", "changed", updated);
    return updated;
  }

  remove(id: string): void {
    const ctx = this.contexts.get(id);
    if (!ctx) {
      return;
    }
    ctx.close();
    this.contexts.delete(id);
    this.globalStorage.removeWorkspace(id);

    if (this.activeId === id) {
      const remaining = this.list();
      this.activeId = remaining.length > 0 ? remaining[0].id : null;
      this.stateService.setState({ lastActiveWorkspaceId: this.activeId ?? undefined });
    }

    this.broadcastFn("workspace", "removed", { id });
  }

  activate(id: string): void {
    if (!this.contexts.has(id)) {
      throw new Error(`workspace not found: ${id}`);
    }
    this.activeId = id;
    this.stateService.setState({ lastActiveWorkspaceId: id });
  }
}
