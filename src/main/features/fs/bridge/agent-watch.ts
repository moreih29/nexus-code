import { z } from "zod";
import { FsChangeSchema } from "../../../../shared/fs/types";
import type { BroadcastFn, WorkspaceManager } from "../../workspace/manager";
import { isAgentBackedProvider, type AgentBackedProvider } from "./provider";

const AgentFsChangedPayloadSchema = z.object({
  changes: z.array(FsChangeSchema),
});

interface WatchSubscription {
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

  constructor(
    private readonly manager: WorkspaceManager,
    private readonly broadcast: BroadcastFn,
  ) {}

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
    for (const subscription of this.subscriptions.values()) {
      subscription.unsubscribe();
    }
    this.subscriptions.clear();
  }

  private ensureSubscription(
    workspaceId: string,
    provider: AgentBackedProvider,
  ): WatchSubscription {
    const existing = this.subscriptions.get(workspaceId);
    if (existing) return existing;

    const unsubscribe = provider.onAgentEvent("fs.changed", (payload) => {
      const parsed = AgentFsChangedPayloadSchema.safeParse(payload);
      if (!parsed.success || parsed.data.changes.length === 0) return;
      this.broadcast("fs", "changed", {
        workspaceId,
        changes: parsed.data.changes,
      });
    });

    const subscription = { unsubscribe, watchedRelPaths: new Set<string>() };
    this.subscriptions.set(workspaceId, subscription);
    return subscription;
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
