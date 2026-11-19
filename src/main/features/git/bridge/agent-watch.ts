import {
  AgentGitChangedPayloadSchema,
  GIT_CHANGED_EVENT,
  GIT_UNWATCH_METHOD,
  GIT_WATCH_METHOD,
} from "../../../../shared/git/protocol";
import { createLogger } from "../../../../shared/log/main";
import { type AgentBackedProvider, isAgentBackedProvider } from "../../fs/bridge/provider";
import type { WorkspaceManager } from "../../workspace/manager";

const log = createLogger("git");

export type GitDirtyCallback = (workspaceId: string) => void;

interface GitWatchEntry {
  readonly gitDir: string;
  readonly provider: AgentBackedProvider;
  readonly unsubscribe: () => void;
  ready: Promise<void>;
  registering: boolean;
}

/** Owns each workspace's agent-side Git watch and forwards changes to the coalescer. */
export class AgentGitWatcher {
  private readonly entries = new Map<string, GitWatchEntry>();
  private readonly pending = new Map<string, Promise<void>>();
  private readonly disposeProviderReady: () => void;
  private disposed = false;

  constructor(
    private readonly manager: WorkspaceManager,
    private readonly onDirty: GitDirtyCallback,
  ) {
    this.disposeProviderReady = manager.onProviderReady((workspaceId, provider) => {
      const entry = this.entries.get(workspaceId);
      if (!entry || !isAgentBackedProvider(provider) || entry.provider === provider) return;
      const next = this.bind(workspaceId, entry.gitDir, provider);
      void next.ready.then(
        () => {
          if (this.entries.get(workspaceId) === next) this.onDirty(workspaceId);
        },
        (error: unknown) => {
          log.warn(
            `git.watch rebind failed (workspace=${workspaceId}, gitDir=${entry.gitDir}): ${(error as Error).message}`,
          );
        },
      );
    });
  }

  /** Registers a repository or joins its pending registration. */
  async watch(workspaceId: string, gitDir: string): Promise<void> {
    if (this.disposed) throw new Error("Git watcher is disposed");
    const provider = this.manager.requireContext(workspaceId).fs;
    if (!isAgentBackedProvider(provider))
      throw new Error("workspace agent provider is not available");
    await this.bind(workspaceId, gitDir, provider).ready;
  }

  /** Detaches the entry now and unwatches on the agent that received the registration. */
  async unwatch(workspaceId: string): Promise<void> {
    const entry = this.entries.get(workspaceId);
    if (!entry) return;
    this.detach(workspaceId, entry);
    await this.enqueue(workspaceId, async () => {
      await entry.provider.callAgentMethod(GIT_UNWATCH_METHOD, { gitDir: entry.gitDir });
    });
  }

  /** Drops a workspace without blocking its removal broadcast. */
  disposeWorkspace(workspaceId: string): void {
    void this.unwatch(workspaceId).catch((error: unknown) => {
      log.warn(
        `git.unwatch cleanup failed (workspace=${workspaceId}): ${(error as Error).message}`,
      );
    });
  }

  /** Stops rebinding and drops all active and pending registrations. */
  dispose(): void {
    this.disposed = true;
    this.disposeProviderReady();
    for (const workspaceId of this.entries.keys()) this.disposeWorkspace(workspaceId);
  }

  /** Publishes the entry before RPC so failure, removal and rebind all find its listeners. */
  private bind(workspaceId: string, gitDir: string, provider: AgentBackedProvider): GitWatchEntry {
    const previous = this.entries.get(workspaceId);
    if (previous?.gitDir === gitDir && previous.provider === provider) return previous;
    if (previous) {
      if (previous.provider === provider || previous.registering)
        this.disposeWorkspace(workspaceId);
      else this.detach(workspaceId, previous);
    }

    const offChanged = provider.onAgentEvent(GIT_CHANGED_EVENT, (payload) => {
      if (this.entries.get(workspaceId) !== entry) return;
      const parsed = AgentGitChangedPayloadSchema.safeParse(payload);
      if (parsed.success && parsed.data.gitDir === gitDir) this.onDirty(workspaceId);
    });
    const offLifecycle = provider.onAgentLifecycle((event) => {
      if (event.type !== "ready" || this.entries.get(workspaceId) !== entry) return;
      void this.enqueue(workspaceId, async () => {
        if (this.entries.get(workspaceId) === entry) {
          entry.registering = true;
          try {
            await provider.callAgentMethod(GIT_WATCH_METHOD, { gitDir });
          } finally {
            entry.registering = false;
          }
        }
      }).catch((error: unknown) => {
        log.warn(
          `git.watch replay failed (workspace=${workspaceId}, gitDir=${gitDir}): ${(error as Error).message}`,
        );
      });
      // Refresh status for changes the disconnected agent did not see.
      this.onDirty(workspaceId);
    });

    const entry: GitWatchEntry = {
      gitDir,
      provider,
      unsubscribe: () => {
        offChanged();
        offLifecycle();
      },
      ready: Promise.resolve(),
      registering: true,
    };
    this.entries.set(workspaceId, entry);
    entry.ready = this.enqueue(workspaceId, async () => {
      if (this.entries.get(workspaceId) !== entry) return;
      try {
        await provider.callAgentMethod(GIT_WATCH_METHOD, { gitDir });
      } catch (error) {
        if (this.entries.get(workspaceId) === entry) {
          if ((error as { code?: string }).code === "transport.timeout") {
            this.disposeWorkspace(workspaceId);
          } else {
            this.detach(workspaceId, entry);
          }
        }
        throw error;
      } finally {
        entry.registering = false;
      }
    });
    return entry;
  }

  /** Removes local ownership before any asynchronous cleanup. */
  private detach(workspaceId: string, entry: GitWatchEntry): void {
    this.entries.delete(workspaceId);
    entry.unsubscribe();
  }

  /** Orders replacement, replay and cleanup for one workspace's repository. */
  private enqueue(workspaceId: string, run: () => Promise<void>): Promise<void> {
    const previous = this.pending.get(workspaceId);
    const pending = (previous ? previous.then(run, run) : run()).finally(() => {
      if (this.pending.get(workspaceId) === pending) this.pending.delete(workspaceId);
    });
    this.pending.set(workspaceId, pending);
    return pending;
  }
}
