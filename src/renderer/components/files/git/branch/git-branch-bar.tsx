/**
 * GitBranchBar renders the panel footer branch/sync chip.
 */
import type {
  BranchInfo,
  GitAutofetchIntervalMin,
  RepoCapabilities,
} from "../../../../../shared/types/git";
import { GitBranchPopover } from "./git-branch-popover";

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
    <div className="flex h-11 shrink-0 items-center gap-1 border-t border-mist-border bg-frosted-veil px-1 text-app-ui-sm text-muted-foreground">
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
  );
}
