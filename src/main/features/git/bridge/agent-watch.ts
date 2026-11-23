import {
  AgentGitChangedPayloadSchema,
  GIT_CHANGED_EVENT,
  GIT_UNWATCH_METHOD,
  GIT_WATCH_METHOD,
} from "../../../../shared/git/protocol";
import { limitLog } from "../../../../shared/log/limit";
import { createLogger } from "../../../../shared/log/main";
import { type AgentBackedProvider, isAgentBackedProvider } from "../../fs/bridge/provider";
import { reportWatchFailure } from "../../fs/bridge/watch-failure-log";
import { enqueueWatchOperation, subscribeAgentWatch } from "../../fs/bridge/watch-lifecycle";
import type { WorkspaceManager } from "../../workspace/manager";

const log = createLogger("git");
const failures = limitLog(log);

export type GitDirtyCallback = (workspaceId: string) => void;

interface GitWatchEntry {
  readonly gitDir: string;
  readonly provider: AgentBackedProvider;
  readonly unsubscribe: () => void;
  ready: Promise<void>;
  registering: boolean;
}

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
          reportWatchFailure(failures, "git.watch rebind", workspaceId, error);
        },
      );
    });
  }

  async watch(workspaceId: string, gitDir: string): Promise<void> {
    if (this.disposed) throw new Error("Git watcher is disposed");
    const provider = this.manager.requireContext(workspaceId).fs;
    if (!isAgentBackedProvider(provider))
      throw new Error("workspace agent provider is not available");
    await this.bind(workspaceId, gitDir, provider).ready;
  }

  async unwatch(workspaceId: string): Promise<void> {
    const entry = this.entries.get(workspaceId);
    if (!entry) return;
    this.detach(workspaceId, entry);
    await enqueueWatchOperation(this.pending, workspaceId, async () => {
      await entry.provider.callAgentMethod(GIT_UNWATCH_METHOD, { gitDir: entry.gitDir });
    });
  }

  disposeWorkspace(workspaceId: string): void {
    void this.unwatch(workspaceId).catch((error: unknown) => {
      reportWatchFailure(failures, "git.unwatch cleanup", workspaceId, error);
    });
  }

  dispose(): void {
    this.disposed = true;
    this.disposeProviderReady();
    for (const workspaceId of this.entries.keys()) this.disposeWorkspace(workspaceId);
  }

  private bind(workspaceId: string, gitDir: string, provider: AgentBackedProvider): GitWatchEntry {
    const previous = this.entries.get(workspaceId);
    if (previous?.gitDir === gitDir && previous.provider === provider) return previous;
    if (previous) {
      if (previous.provider === provider || previous.registering)
        this.disposeWorkspace(workspaceId);
      else this.detach(workspaceId, previous);
    }

    const unsubscribe = subscribeAgentWatch(
      provider,
      GIT_CHANGED_EVENT,
      () => this.entries.get(workspaceId) === entry,
      (payload) => {
        const parsed = AgentGitChangedPayloadSchema.safeParse(payload);
        if (parsed.success && parsed.data.gitDir === gitDir) this.onDirty(workspaceId);
      },
      () => {
        void enqueueWatchOperation(this.pending, workspaceId, async () => {
          if (this.entries.get(workspaceId) === entry) {
            entry.registering = true;
            try {
              await provider.callAgentMethod(GIT_WATCH_METHOD, { gitDir });
            } finally {
              entry.registering = false;
            }
          }
        }).catch((error: unknown) => {
          reportWatchFailure(failures, "git.watch replay", workspaceId, error);
        });
        this.onDirty(workspaceId);
      },
    );

    const entry: GitWatchEntry = {
      gitDir,
      provider,
      unsubscribe,
      ready: Promise.resolve(),
      registering: true,
    };
    this.entries.set(workspaceId, entry);
    entry.ready = enqueueWatchOperation(this.pending, workspaceId, async () => {
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

  private detach(workspaceId: string, entry: GitWatchEntry): void {
    this.entries.delete(workspaceId);
    entry.unsubscribe();
  }
}
