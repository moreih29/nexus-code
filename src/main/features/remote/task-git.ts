import type { RemoteWorkspace } from "../../../../packages/remote-protocol/src";
import type { GitStatus } from "../../../shared/git/types";
import type { WorkspaceMeta } from "../../../shared/types/workspace";

export const REFRESH_MS = 20_000;

export type TaskGitFacts = NonNullable<RemoteWorkspace["git"]>;

interface Kept {
  facts: TaskGitFacts | null;
  at: number;
  asking: boolean;
}

export function factsOf(status: GitStatus): TaskGitFacts {
  const changed = new Set<string>();
  for (const entry of [...status.merge, ...status.staged, ...status.working, ...status.untracked]) {
    changed.add(entry.relPath);
  }
  return {
    branch: status.branch && !status.branch.isUnborn ? status.branch.current : null,
    ahead: status.branch?.ahead ?? 0,
    behind: status.branch?.behind ?? 0,
    uncommitted: changed.size,
  };
}

export class TaskGit {
  private readonly kept = new Map<string, Kept>();

  constructor(
    private readonly status: (workspaceId: string) => Promise<GitStatus | null>,
    private readonly now: () => number = Date.now,
  ) {}

  facts = (workspace: WorkspaceMeta): TaskGitFacts | undefined => {
    const kept = this.kept.get(workspace.id);
    if (!kept || (!kept.asking && this.now() - kept.at >= REFRESH_MS)) this.refresh(workspace.id);
    return kept?.facts ?? undefined;
  };

  forget(workspaceId: string): void {
    this.kept.delete(workspaceId);
  }

  private refresh(workspaceId: string): void {
    const kept = this.kept.get(workspaceId) ?? { facts: null, at: 0, asking: false };
    kept.asking = true;
    this.kept.set(workspaceId, kept);
    void this.status(workspaceId)
      .then((status) => (status ? factsOf(status) : null))
      .catch(() => kept.facts)
      .then((facts) => {
        kept.facts = facts;
        kept.at = this.now();
        kept.asking = false;
      });
  }
}
