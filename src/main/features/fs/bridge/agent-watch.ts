import { z } from "zod";
import { FsChangeSchema } from "../../../../shared/fs/types";
import { createLogger } from "../../../../shared/log/main";
import type { BroadcastFn, WorkspaceManager } from "../../workspace/manager";
import { type AgentBackedProvider, isAgentBackedProvider } from "./provider";
import { enqueueWatchOperation, subscribeAgentWatch } from "./watch-lifecycle";

const log = createLogger("fs");
const AgentFsChangedPayloadSchema = z.object({ changes: z.array(FsChangeSchema) });

interface WatchSubscription {
  readonly provider: AgentBackedProvider;
  readonly unsubscribe: () => void;
}

interface WorkspaceWatches {
  readonly paths: Set<string>;
  readonly pending: Map<string, Promise<void>>;
  subscription?: WatchSubscription;
}

/** Owns each workspace's desired paths and forwards changes from its current agent. */
export class AgentFsWatcher {
  private readonly workspaces = new Map<string, WorkspaceWatches>();
  private readonly disposeProviderReady: () => void;
  private disposed = false;

  constructor(
    private readonly manager: WorkspaceManager,
    private readonly broadcast: BroadcastFn,
  ) {
    this.disposeProviderReady = manager.onProviderReady((workspaceId, provider) => {
      const state = this.workspaces.get(workspaceId);
      if (state && isAgentBackedProvider(provider)) this.bind(workspaceId, state, provider);
    });
  }

  /** Tracks a requested path before its RPC completes so teardown and rebind can see it. */
  async watch(workspaceId: string, relPath: string): Promise<void> {
    const state = this.state(workspaceId);
    await this.enqueue(workspaceId, state, relPath, async () => {
      if (this.workspaces.get(workspaceId) !== state) return;
      const provider = await this.requireReadyAgentProvider(workspaceId);
      if (this.workspaces.get(workspaceId) !== state) return;
      const subscription = this.bind(workspaceId, state, provider);
      const wasWatched = state.paths.has(relPath);
      state.paths.add(relPath);
      try {
        await provider.callAgentMethod("fs.watch", { relPath });
      } catch (error) {
        if (!wasWatched && state.subscription === subscription) {
          state.paths.delete(relPath);
          if ((error as { code?: string }).code === "transport.timeout") {
            await this.cleanup(workspaceId, provider, relPath);
          }
        }
        throw error;
      }
      if (state.subscription !== subscription) {
        await this.cleanup(workspaceId, provider, relPath);
      }
    });
  }

  /** Stops a path after any earlier watch or replay of that same path. */
  async unwatch(workspaceId: string, relPath: string): Promise<void> {
    const state = this.state(workspaceId);
    await this.enqueue(workspaceId, state, relPath, async () => {
      if (this.workspaces.get(workspaceId) !== state) return;
      state.paths.delete(relPath);
      const provider = await this.requireReadyAgentProvider(workspaceId);
      if (this.workspaces.get(workspaceId) !== state) return;
      if (state.paths.size > 0) this.bind(workspaceId, state, provider);
      await provider.callAgentMethod("fs.unwatch", { relPath });
    });
  }

  /** Detaches the listener immediately and clears watches after pending registrations settle. */
  disposeWorkspace(workspaceId: string): void {
    const state = this.workspaces.get(workspaceId);
    if (!state) return;
    this.workspaces.delete(workspaceId);
    const subscription = state.subscription;
    if (!subscription) return;
    subscription.unsubscribe();
    for (const relPath of state.paths) {
      void this.enqueue(workspaceId, state, relPath, () =>
        this.cleanup(workspaceId, subscription.provider, relPath),
      );
    }
  }

  /** Stops new subscriptions and drops every workspace. */
  dispose(): void {
    this.disposed = true;
    this.disposeProviderReady();
    for (const workspaceId of this.workspaces.keys()) this.disposeWorkspace(workspaceId);
  }

  /** Finds or creates the state before awaiting a provider. */
  private state(workspaceId: string): WorkspaceWatches {
    if (this.disposed) throw new Error("file watcher is disposed");
    const existing = this.workspaces.get(workspaceId);
    if (existing) return existing;
    const state = { paths: new Set<string>(), pending: new Map<string, Promise<void>>() };
    this.workspaces.set(workspaceId, state);
    return state;
  }

  /** Orders RPCs for one path while allowing other directories to progress independently. */
  private enqueue(
    workspaceId: string,
    state: WorkspaceWatches,
    relPath: string,
    run: () => Promise<void>,
  ): Promise<void> {
    return enqueueWatchOperation(state.pending, relPath, run, () => {
      if (
        this.workspaces.get(workspaceId) === state &&
        state.paths.size === 0 &&
        state.pending.size === 0
      ) {
        state.subscription?.unsubscribe();
        this.workspaces.delete(workspaceId);
      }
    });
  }

  /** Moves the listener and desired paths to the new provider. */
  private bind(
    workspaceId: string,
    state: WorkspaceWatches,
    provider: AgentBackedProvider,
  ): WatchSubscription {
    const previous = state.subscription;
    if (previous?.provider === provider) return previous;
    previous?.unsubscribe();

    const unsubscribe = subscribeAgentWatch(
      provider,
      "fs.changed",
      () => this.workspaces.get(workspaceId) === state && state.subscription === subscription,
      (payload) => {
        const parsed = AgentFsChangedPayloadSchema.safeParse(payload);
        if (!parsed.success || parsed.data.changes.length === 0) return;
        this.broadcast("fs", "changed", { workspaceId, changes: parsed.data.changes });
      },
      () => this.replay(workspaceId, state, subscription),
    );
    const subscription = { provider, unsubscribe };
    state.subscription = subscription;
    if (previous) this.replay(workspaceId, state, subscription);
    return subscription;
  }

  /** Restores still-wanted paths and refreshes directories changed during the outage. */
  private replay(
    workspaceId: string,
    state: WorkspaceWatches,
    subscription: WatchSubscription,
  ): void {
    for (const relPath of state.paths) {
      void this.enqueue(workspaceId, state, relPath, async () => {
        if (
          this.workspaces.get(workspaceId) !== state ||
          state.subscription !== subscription ||
          !state.paths.has(relPath)
        ) {
          return;
        }
        await subscription.provider.callAgentMethod("fs.watch", { relPath });
        if (state.subscription !== subscription) {
          await this.cleanup(workspaceId, subscription.provider, relPath);
        }
      }).catch((error: unknown) => {
        log.warn(
          `fs.watch replay failed (workspace=${workspaceId}, relPath=${relPath}): ${(error as Error).message}`,
        );
      });
    }
    if (state.paths.size > 0) {
      this.broadcast("fs", "changed", {
        workspaceId,
        changes: [...state.paths].map((relPath) => ({ relPath, kind: "added" as const })),
      });
    }
  }

  /** Releases a retired path on the provider that received its watch. */
  private async cleanup(
    workspaceId: string,
    provider: AgentBackedProvider,
    relPath: string,
  ): Promise<void> {
    try {
      await provider.callAgentMethod("fs.unwatch", { relPath });
    } catch (error) {
      log.warn(
        `fs.unwatch cleanup failed (workspace=${workspaceId}, relPath=${relPath}): ${(error as Error).message}`,
      );
    }
  }

  /** Waits for the live agent instead of using the inert provider during bootstrap. */
  private async requireReadyAgentProvider(workspaceId: string): Promise<AgentBackedProvider> {
    const provider = await this.manager.getFs(workspaceId);
    if (!isAgentBackedProvider(provider))
      throw new Error("workspace agent provider is not available");
    return provider;
  }
}
