/**
 * GitHeader renders the Source Control title and top-level action buttons.
 */
import type { GitAutofetchIntervalMin, RepoCapabilities } from "../../../../../shared/git/types";
import type { ViewMode } from "../../../../../shared/types/panel";
import { GitMoreMenu } from "../more-menu";
import type { GitTagPickerMenuMode } from "../utils/more-menu-model";
import { GitHeaderBar } from "./header-bar";

interface GitHeaderProps {
  disabled?: boolean;
  refreshing?: boolean;
  canInit?: boolean;
  /** The workspace's host has no Git; forwarded to GitMoreMenu. */
  gitMissing?: boolean;
  hasChanges?: boolean;
  /** Repo-level capability flags forwarded to GitMoreMenu for per-action enablement. */
  capabilities?: RepoCapabilities;
  /** When true the repo is not yet detected/initialised — ViewModeToggle is hidden. */
  showViewToggle?: boolean;
  viewMode?: ViewMode;
  onViewModeChange?: (next: ViewMode) => void;
  /**
   * True when at least one directory is currently expanded across any group.
   * Drives the single toolbar toggle: expanded → "collapse all", fully
   * collapsed → "expand all".
   */
  hasAnyExpanded?: boolean;
  /**
   * Fires when the user clicks the expand/collapse toggle. The caller decides
   * which underlying store action to invoke based on `hasAnyExpanded`.
   */
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
