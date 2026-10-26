import { z } from "zod";
import { FsChangeSchema } from "../../../../shared/fs/types";
import { createLogger } from "../../../../shared/log/main";
import type { BroadcastFn, WorkspaceManager } from "../../workspace/manager";
import { isAgentBackedProvider, type AgentBackedProvider } from "./provider";

const log = createLogger("fs");

const AgentFsChangedPayloadSchema = z.object({
  changes: z.array(FsChangeSchema),
});

interface WatchSubscription {
  readonly provider: AgentBackedProvider;
  readonly unsubscribe: () => void;
  readonly watchedRelPaths: Set<string>;
}

/**
 * Bridges agent-emitted fs.changed events into renderer IPC events.
 *
 * The OS watcher itself lives inside the Go agent. This class only owns
 * per-workspace event subscription and workspaceId fan-out.
 */
export class AgentFsWatcher {
  private readonly subscriptions = new Map<string, WatchSubscription>();
  private readonly disposeProviderReady: () => void;

  constructor(
    private readonly manager: WorkspaceManager,
    private readonly broadcast: BroadcastFn,
  ) {
    // After the channel dies, the next boot brings up a new agent with no
    // watches, and the listeners on the old provider never fire again. Move
    // existing subscriptions over as soon as the replacement is up rather
    // than waiting for the renderer to watch again, which it does not do for
    // directories that were already expanded.
    this.disposeProviderReady = manager.onProviderReady((workspaceId, provider) => {
      if (this.subscriptions.has(workspaceId) && isAgentBackedProvider(provider)) {
        this.ensureSubscription(workspaceId, provider);
      }
    });
  }

  async watch(workspaceId: string, relPath: string): Promise<void> {
    const provider = await this.requireReadyAgentProvider(workspaceId);
    const subscription = this.ensureSubscription(workspaceId, provider);
    await provider.callAgentMethod("fs.watch", { relPath });
    subscription.watchedRelPaths.add(relPath);
  }

  async unwatch(workspaceId: string, relPath: string): Promise<void> {
    const provider = await this.requireReadyAgentProvider(workspaceId);
    await provider.callAgentMethod("fs.unwatch", { relPath });

    const subscription = this.subscriptions.get(workspaceId);
    subscription?.watchedRelPaths.delete(relPath);
    if (subscription && subscription.watchedRelPaths.size === 0) {
      subscription.unsubscribe();
      this.subscriptions.delete(workspaceId);
    }
  }

  disposeWorkspace(workspaceId: string): void {
    const subscription = this.subscriptions.get(workspaceId);
    if (!subscription) return;
    subscription.unsubscribe();
    this.subscriptions.delete(workspaceId);
  }

  dispose(): void {
    this.disposeProviderReady();
    for (const subscription of this.subscriptions.values()) {
      subscription.unsubscribe();
    }
    this.subscriptions.clear();
  }

  /**
   * Returns the workspace's subscription on `provider`. One made on an
   * earlier provider is moved over: its listeners are dropped and its paths
   * are registered with the new agent.
   */
  private ensureSubscription(
    workspaceId: string,
    provider: AgentBackedProvider,
  ): WatchSubscription {
    const existing = this.subscriptions.get(workspaceId);
    if (existing?.provider === provider) return existing;

    existing?.unsubscribe();
    const subscription = this.subscribe(workspaceId, provider);
    if (existing) {
      for (const relPath of existing.watchedRelPaths) {
        subscription.watchedRelPaths.add(relPath);
      }
      this.replayWatches(workspaceId, provider, subscription);
    }
    return subscription;
  }

  private subscribe(workspaceId: string, provider: AgentBackedProvider): WatchSubscription {
    const unsubscribeChanged = provider.onAgentEvent("fs.changed", (payload) => {
      const parsed = AgentFsChangedPayloadSchema.safeParse(payload);
      if (!parsed.success || parsed.data.changes.length === 0) return;
      this.broadcast("fs", "changed", {
        workspaceId,
        changes: parsed.data.changes,
      });
    });

    // Watch registrations live in the agent process, so a respawned agent
    // starts with zero watches even though the channel recovered
    // transparently. Replay the full set on the `ready` lifecycle event
    // (successful reconnect handshake) — re-registering an existing watch is
    // a no-op on the agent side, so the replay is safe even when the agent
    // actually survived.
    const unsubscribeLifecycle = provider.onAgentLifecycle((event) => {
      if (event.type !== "ready") return;
      const subscription = this.subscriptions.get(workspaceId);
      if (!subscription) return;
      this.replayWatches(workspaceId, provider, subscription);
    });

    const subscription = {
      provider,
      unsubscribe: () => {
        unsubscribeChanged();
        unsubscribeLifecycle();
      },
      watchedRelPaths: new Set<string>(),
    };
    this.subscriptions.set(workspaceId, subscription);
    return subscription;
  }

  /**
   * Registers every watched path with an agent that does not have them.
   */
  private replayWatches(
    workspaceId: string,
    provider: AgentBackedProvider,
    subscription: WatchSubscription,
  ): void {
    for (const relPath of subscription.watchedRelPaths) {
      provider.callAgentMethod("fs.watch", { relPath }).catch((error: unknown) => {
        log.warn(
          `fs.watch replay failed (workspace=${workspaceId}, relPath=${relPath}): ${(error as Error).message}`,
        );
      });
    }
    // Changes made while the agent was down were never reported. Replay
    // every watched directory as "added" so the renderer re-reads each one
    // (the file tree treats an added directory as recreated) and its
    // fs.changed hint refreshes git status.
    if (subscription.watchedRelPaths.size > 0) {
      this.broadcast("fs", "changed", {
        workspaceId,
        changes: [...subscription.watchedRelPaths].map((relPath) => ({
          relPath,
          kind: "added" as const,
        })),
      });
    }
  }

  /**
   * Resolves the workspace's agent-backed fs provider only after the
   * underlying channel is ready. Without this gate, fs.watch IPC that
   * arrives before SSH bootstrap or local channel boot completes would
   * subscribe against the inert provider returned by createInitialFsProvider
   * and throw `channel not yet wired` from the channel accessor.
   */
  private async requireReadyAgentProvider(workspaceId: string): Promise<AgentBackedProvider> {
    const provider = await this.manager.getFs(workspaceId);
    if (!isAgentBackedProvider(provider)) {
      throw new Error("workspace agent provider is not available");
    }
    return provider;
  }
}
