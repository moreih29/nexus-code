/**
 * GitBranchBar renders the panel footer branch/sync chip.
 */
import type {
  BranchInfo,
  GitAutofetchIntervalMin,
  RepoCapabilities,
} from "../../../../../shared/git/types";
import { GitBranchPopover } from "./branch-popover";

interface GitBranchBarProps {
  workspaceId: string;
  branch: BranchInfo | null;
  repoPath?: string;
  disabled?: boolean;
  capabilities?: RepoCapabilities;
  autofetchIntervalMin: GitAutofetchIntervalMin;
  autofetchFetching?: boolean;
  autofetchFailed?: boolean;
  onSync: () => void;
  onFetch: () => void;
  onPull: () => void;
  onPush: () => void;
  onPublish: () => void;
  onSetAutofetchInterval: (intervalMin: GitAutofetchIntervalMin) => void;
  onSwitchBranch: () => void;
  onCreateFromRef: () => void;
}

export function GitBranchBar({
  workspaceId,
  branch,
  repoPath,
  disabled = false,
  capabilities,
  autofetchIntervalMin,
  autofetchFetching = false,
  autofetchFailed = false,
  onSync,
  onFetch,
  onPull,
  onPush,
  onPublish,
  onSetAutofetchInterval,
}: GitBranchBarProps) {
  return (
    <div className="flex shrink-0 flex-col border-t border-border bg-muted">
      {branch?.isUnborn ? (
        <p className="px-3 pt-1 text-app-ui-sm text-muted-foreground">
          {`'${branch.current}' has no commits yet — it will be created on your first commit.`}
        </p>
      ) : null}
      <div className="flex h-9 items-center gap-1 px-1 text-app-ui-sm text-muted-foreground">
        <GitBranchPopover
          workspaceId={workspaceId}
          branch={branch}
          repoPath={repoPath}
          disabled={disabled}
          capabilities={capabilities}
          autofetchIntervalMin={autofetchIntervalMin}
          autofetchFetching={autofetchFetching}
          autofetchFailed={autofetchFailed}
          onSync={onSync}
          onFetch={onFetch}
          onPull={onPull}
          onPush={onPush}
          onPublish={onPublish}
          onSetAutofetchInterval={onSetAutofetchInterval}
        />
      </div>
    </div>
  );
}
