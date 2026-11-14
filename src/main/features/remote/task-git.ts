/**
 * How each task's branch stands, for the sessions' list other devices see:
 * its branch, how far ahead and behind its upstream, and how many files it
 * changed and did not commit. The list is read every second while watched,
 * far more often than git should run, so each task's facts are kept and
 * looked at again only once they are REFRESH_MS old, in the background:
 * the list shows what was last seen, and the next read the newer facts.
 */
import type { RemoteWorkspace } from "../../../../packages/remote-protocol/src";
import type { GitStatus } from "../../../shared/git/types";
import type { WorkspaceMeta } from "../../../shared/types/workspace";

/** How old a task's facts may get before git is asked again. */
export const REFRESH_MS = 20_000;

export type TaskGitFacts = NonNullable<RemoteWorkspace["git"]>;

interface Kept {
  facts: TaskGitFacts | null;
  at: number;
  asking: boolean;
}

/** A status's facts: its branch, ahead and behind, and its changed files counted once each. */
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
    /** The workspace's git status now; null where it is no repository. */
    private readonly status: (workspaceId: string) => Promise<GitStatus | null>,
    private readonly now: () => number = Date.now,
  ) {}

  /** The task's facts as last seen, asking git again when they are old; none for a workspace that is no task. */
  facts = (workspace: WorkspaceMeta): TaskGitFacts | undefined => {
    if (!workspace.task) return undefined;
    const kept = this.kept.get(workspace.id);
    if (!kept || (!kept.asking && this.now() - kept.at >= REFRESH_MS)) this.refresh(workspace.id);
    return kept?.facts ?? undefined;
  };

  /** A workspace gone: its facts too. */
  forget(workspaceId: string): void {
    this.kept.delete(workspaceId);
  }

  private refresh(workspaceId: string): void {
    const kept = this.kept.get(workspaceId) ?? { facts: null, at: 0, asking: false };
    kept.asking = true;
    this.kept.set(workspaceId, kept);
    void this.status(workspaceId)
      .then((status) => (status ? factsOf(status) : null))
      // A repository that cannot be read now (a host away): its last facts stay.
      .catch(() => kept.facts)
      .then((facts) => {
        kept.facts = facts;
        kept.at = this.now();
        kept.asking = false;
      });
  }
}
