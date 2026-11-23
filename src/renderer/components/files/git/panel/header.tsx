import type { GitAutofetchIntervalMin, RepoCapabilities } from "../../../../../shared/git/types";
import type { ViewMode } from "../../../../../shared/types/panel";
import { GitMoreMenu } from "../more-menu";
import type { GitTagPickerMenuMode } from "../utils/more-menu-model";
import { GitHeaderBar } from "./header-bar";

interface GitHeaderProps {
  disabled?: boolean;
  refreshing?: boolean;
  canInit?: boolean;
  gitMissing?: boolean;
  hasChanges?: boolean;
  capabilities?: RepoCapabilities;
  showViewToggle?: boolean;
  viewMode?: ViewMode;
  onViewModeChange?: (next: ViewMode) => void;
  hasAnyExpanded?: boolean;
  onToggleAllTrees?: () => void;
  onRefresh: () => void;
  onInit: () => void;
  onFetch: () => void;
  onPull: () => void;
  onPush: () => void;
  onStash: () => void;
  onStashPop: () => void;
  onOpenStashes: () => void;
  onDropStash: () => void;
  onOpenTags: (mode: GitTagPickerMenuMode, remote?: string) => void;
  onSwitchBranch: () => void;
  onMergeBranch: () => void;
  onRebaseBranch: () => void;
  onCreateBranch: () => void;
  onCreateBranchFrom: () => void;
  onRenameBranch: () => void;
  onDeleteBranch: () => void;
  onDeleteRemoteBranch: () => void;
  onPushTags: (remote: string) => void;
  onAddRemote: () => void;
  onRemoveRemote: (remote: string) => void;
  onDiscardAll: () => void;
  autofetchIntervalMin: GitAutofetchIntervalMin;
  lastFetchedAt: number | null;
  onSetAutofetchInterval: (intervalMin: GitAutofetchIntervalMin) => void;
}

export function GitHeader({
  disabled = false,
  refreshing = false,
  canInit = false,
  gitMissing = false,
  hasChanges = false,
  capabilities,
  showViewToggle = false,
  viewMode = "tree",
  onViewModeChange,
  hasAnyExpanded = false,
  onToggleAllTrees,
  onRefresh,
  onInit,
  onFetch,
  onPull,
  onPush,
  onStash,
  onStashPop,
  onOpenStashes,
  onDropStash,
  onOpenTags,
  onSwitchBranch,
  onMergeBranch,
  onRebaseBranch,
  onCreateBranch,
  onCreateBranchFrom,
  onRenameBranch,
  onDeleteBranch,
  onDeleteRemoteBranch,
  onPushTags,
  onAddRemote,
  onRemoveRemote,
  onDiscardAll,
  autofetchIntervalMin,
  lastFetchedAt,
  onSetAutofetchInterval,
}: GitHeaderProps) {
  return (
    <GitHeaderBar
      disabled={disabled}
      refreshing={refreshing}
      hasChanges={hasChanges}
      showViewToggle={showViewToggle}
      viewMode={viewMode}
      onViewModeChange={onViewModeChange}
      hasAnyExpanded={hasAnyExpanded}
      onToggleAllTrees={onToggleAllTrees}
      onRefresh={onRefresh}
    >
      <GitMoreMenu
        disabled={disabled}
        canInit={canInit}
        gitMissing={gitMissing}
        hasChanges={hasChanges}
        capabilities={capabilities}
        onRefresh={onRefresh}
        onInit={onInit}
        onFetch={onFetch}
        onPull={onPull}
        onPush={onPush}
        onStash={onStash}
        onStashPop={onStashPop}
        onOpenStashes={onOpenStashes}
        onDropStash={onDropStash}
        onOpenTags={onOpenTags}
        onSwitchBranch={onSwitchBranch}
        onMergeBranch={onMergeBranch}
        onRebaseBranch={onRebaseBranch}
        onCreateBranch={onCreateBranch}
        onCreateBranchFrom={onCreateBranchFrom}
        onRenameBranch={onRenameBranch}
        onDeleteBranch={onDeleteBranch}
        onDeleteRemoteBranch={onDeleteRemoteBranch}
        onPushTags={onPushTags}
        onAddRemote={onAddRemote}
        onRemoveRemote={onRemoveRemote}
        onDiscardAll={onDiscardAll}
        autofetchIntervalMin={autofetchIntervalMin}
        lastFetchedAt={lastFetchedAt}
        onSetAutofetchInterval={onSetAutofetchInterval}
      />
    </GitHeaderBar>
  );
}
