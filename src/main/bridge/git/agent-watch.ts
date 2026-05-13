import {
  AgentGitChangedPayloadSchema,
  GIT_CHANGED_EVENT,
  GIT_UNWATCH_METHOD,
  GIT_WATCH_METHOD,
} from "../../../shared/protocol/agent/git";
import type { WorkspaceManager } from "../../workspace/workspace-manager";
import { isAgentBackedProvider, type AgentBackedProvider } from "../fs/provider";

export type GitDirtyCallback = (workspaceId: string) => void;

interface GitWatchEntry {
  readonly gitDir: string;
  readonly unsubscribe: () => void;
}

/**
 * Bridges Go-agent git.changed events into the existing status coalescer.
 * The actual .git directory watcher lives in the agent, so this works for
 * local and SSH workspaces through the same provider channel.
 */
export class AgentGitWatcher {
  private readonly entries = new Map<string, GitWatchEntry>();

  constructor(
    private readonly manager: WorkspaceManager,
    private readonly onDirty: GitDirtyCallback,
  ) {}

  async watch(workspaceId: string, gitDir: string): Promise<void> {
    const provider = this.requireAgentProvider(workspaceId);
    const existing = this.entries.get(workspaceId);
    if (existing?.gitDir === gitDir) {
      return;
    }
    if (existing) {
      await this.unwatch(workspaceId).catch(() => {});
    }

    const unsubscribe = provider.onAgentEvent(GIT_CHANGED_EVENT, (payload) => {
      const parsed = AgentGitChangedPayloadSchema.safeParse(payload);
      if (!parsed.success || parsed.data.gitDir !== gitDir) return;
      this.onDirty(workspaceId);
    });

    await provider.callAgentMethod(GIT_WATCH_METHOD, { gitDir });
    this.entries.set(workspaceId, { gitDir, unsubscribe });
  }

  async unwatch(workspaceId: string): Promise<void> {
    const entry = this.entries.get(workspaceId);
    if (!entry) return;
    this.entries.delete(workspaceId);
    entry.unsubscribe();
    const provider = this.tryAgentProvider(workspaceId);
    if (provider) {
      await provider.callAgentMethod(GIT_UNWATCH_METHOD, { gitDir: entry.gitDir });
    }
  }

  disposeWorkspace(workspaceId: string): void {
    const entry = this.entries.get(workspaceId);
    if (!entry) return;
    this.entries.delete(workspaceId);
    entry.unsubscribe();
    const provider = this.tryAgentProvider(workspaceId);
    void provider?.callAgentMethod(GIT_UNWATCH_METHOD, { gitDir: entry.gitDir }).catch(() => {});
  }

  dispose(): void {
    for (const workspaceId of Array.from(this.entries.keys())) {
      this.disposeWorkspace(workspaceId);
    }
  }

  private requireAgentProvider(workspaceId: string): AgentBackedProvider {
    const provider = this.manager.requireContext(workspaceId).fs;
    if (!isAgentBackedProvider(provider)) {
      throw new Error("workspace agent provider is not available");
    }
    return provider;
  }

  private tryAgentProvider(workspaceId: string): AgentBackedProvider | null {
    try {
      const provider = this.manager.requireContext(workspaceId).fs;
      return isAgentBackedProvider(provider) ? provider : null;
    } catch {
      return null;
    }
  }
}
