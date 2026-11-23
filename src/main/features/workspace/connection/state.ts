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

export function createWorkspaceRemovedError(id: string): Error {
  return createAbortError(`workspace ${id} was removed while its agent was starting`);
}

export function createInitialFsProvider(meta: WorkspaceMeta): AgentFsProvider {
  if (meta.location.kind === "local") {
    return new AgentFsProvider("local");
  }
  return createFsProvider(meta) as AgentFsProvider;
}

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

  onProviderReady(listener: (workspaceId: string, provider: FsProvider) => void): () => void {
    this.providerReadyListeners.add(listener);
    return () => {
      this.providerReadyListeners.delete(listener);
    };
  }

  isLiveContext(id: string, ctx: WorkspaceContext): boolean {
    return this.contexts.get(id) === ctx;
  }

  removeShimDirQuietly(id: string): void {
    this.removeShimDir(id).catch((err: unknown) => {
      log.warn(`shim dir removal failed for ${id}: ${(err as Error).message}`);
    });
  }

  notifyProviderReady(workspaceId: string, provider: FsProvider): void {
    for (const listener of this.providerReadyListeners) {
      try {
        listener(workspaceId, provider);
      } catch (error) {
        log.warn(`provider-ready listener failed for ${workspaceId}: ${(error as Error).message}`);
      }
    }
  }

  connectionSnapshot(): WorkspaceConnectionChangedEvent[] {
    return Array.from(this.connectionStatuses, ([workspaceId, status]) => ({
      workspaceId,
      status,
    }));
  }

  broadcastConnectionStatus(workspaceId: string, status: WorkspaceConnectionEventStatus): void {
    if (this.connectionStatuses.get(workspaceId) === status) {
      return;
    }
    this.connectionStatuses.set(workspaceId, status);
    this.broadcastFn("workspace", "connectionChanged", { workspaceId, status });
  }

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
