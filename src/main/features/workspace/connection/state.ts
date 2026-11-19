import { createAbortError } from "../../../../shared/abort";
import { createLogger } from "../../../../shared/log/main";
import type {
  WorkspaceConnectionChangedEvent,
  WorkspaceConnectionEventStatus,
  WorkspaceMeta,
} from "../../../../shared/types/workspace";
import type { LspBootstrapProgressEvent } from "../../../infra/agent/ssh/ssh-bootstrap/index";
import { AgentFsProvider } from "../../fs/bridge/agent-provider";
import { createFsProvider } from "../../fs/bridge/create-provider";
import type { FsProvider } from "../../fs/bridge/provider";
import type { WorkspaceContext } from "../context";
import type { BroadcastFn, RemoveShimDirFn, WriteShimFilesFn } from "../manager";

const log = createLogger("workspace");

/** Rejects a provider boot whose workspace was removed while it was in flight. */
export function createWorkspaceRemovedError(id: string): Error {
  return createAbortError(`workspace ${id} was removed while its agent was starting`);
}

/**
 * Builds an inert provider for unopened workspaces. Activation replaces it
 * only after the workspace agent has completed its ready handshake.
 */
export function createInitialFsProvider(meta: WorkspaceMeta): AgentFsProvider {
  if (meta.location.kind === "local") {
    return new AgentFsProvider("local");
  }
  return createFsProvider(meta) as AgentFsProvider;
}

/** Shared workspace context, shim operations and notifications for agent connections. */
export class WorkspaceConnectionState {
  readonly connectionStatuses = new Map<string, WorkspaceConnectionEventStatus>();

  private readonly providerReadyListeners = new Set<
    (workspaceId: string, provider: FsProvider) => void
  >();

  constructor(
    readonly contexts: ReadonlyMap<string, WorkspaceContext>,
    readonly broadcastFn: BroadcastFn,
    readonly writeShimFiles: WriteShimFilesFn,
    readonly removeShimDir: RemoveShimDirFn,
  ) {}

  /**
   * Subscribes to agent boots: fires each time a workspace gets a newly
   * started agent provider, on first activation and again when the previous
   * channel died and a later call booted a replacement. The new agent knows
   * nothing the old one had registered (fs and .git watches), and listeners
   * attached to the old provider never hear from it.
   */
  onProviderReady(listener: (workspaceId: string, provider: FsProvider) => void): () => void {
    this.providerReadyListeners.add(listener);
    return () => {
      this.providerReadyListeners.delete(listener);
    };
  }

  /**
   * True while `ctx` is still the open context for `id`, i.e. the workspace
   * was not removed during an await in a provider boot.
   */
  isLiveContext(id: string, ctx: WorkspaceContext): boolean {
    return this.contexts.get(id) === ctx;
  }

  /** Deletes the workspace's PTY shim directory in the background. */
  removeShimDirQuietly(id: string): void {
    this.removeShimDir(id).catch((err: unknown) => {
      log.warn(`shim dir removal failed for ${id}: ${(err as Error).message}`);
    });
  }

  /**
   * Runs the provider-ready listeners; one that throws does not skip the rest.
   */
  notifyProviderReady(workspaceId: string, provider: FsProvider): void {
    for (const listener of this.providerReadyListeners) {
      try {
        listener(workspaceId, provider);
      } catch (error) {
        log.warn(`provider-ready listener failed for ${workspaceId}: ${(error as Error).message}`);
      }
    }
  }

  /** Current remote connection statuses for a newly opened renderer. */
  connectionSnapshot(): WorkspaceConnectionChangedEvent[] {
    return Array.from(this.connectionStatuses, ([workspaceId, status]) => ({
      workspaceId,
      status,
    }));
  }

  /**
   * Broadcasts a workspace connection status only when it actually changes.
   */
  broadcastConnectionStatus(workspaceId: string, status: WorkspaceConnectionEventStatus): void {
    if (this.connectionStatuses.get(workspaceId) === status) {
      return;
    }
    this.connectionStatuses.set(workspaceId, status);
    this.broadcastFn("workspace", "connectionChanged", { workspaceId, status });
  }

  /**
   * Forwards agent bootstrap progress events to the renderer.
   * Scoped by workspaceId, so it covers both the "add new workspace" and "reconnect at app start" flows.
   */
  broadcastConnectionProgress(workspaceId: string, event: LspBootstrapProgressEvent): void {
    this.broadcastFn("workspace", "connectionProgress", {
      workspaceId,
      name: event.name,
      phase: event.phase,
      bytesDone: event.bytesDone,
      bytesTotal: event.bytesTotal,
    });
  }
}
