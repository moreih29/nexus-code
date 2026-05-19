/**
 * GitHeader renders the Source Control title and top-level action buttons.
 */
import { RefreshCw } from "lucide-react";
import type { GitAutofetchIntervalMin, RepoCapabilities } from "../../../../../shared/git/types";
import type { ViewMode } from "../../../../../shared/types/panel";
import { Button } from "../../../ui/button";
import { ExpandCollapseButtons } from "../../expand-collapse-buttons";
import { ViewModeToggle } from "../../view-mode-toggle";
import { GitMoreMenu } from "../more-menu";
import type { GitTagPickerMenuMode } from "../utils/more-menu-model";

interface GitHeaderProps {
  disabled?: boolean;
  refreshing?: boolean;
  canInit?: boolean;
  hasChanges?: boolean;
  /** Repo-level capability flags forwarded to GitMoreMenu for per-action enablement. */
  capabilities?: RepoCapabilities;
  /** When true the repo is not yet detected/initialised — ViewModeToggle is hidden. */
  showViewToggle?: boolean;
  viewMode?: ViewMode;
  onViewModeChange?: (next: ViewMode) => void;
  /** Fires when the user clicks Expand-All on the file-group toolbar. */
  onExpandAllTrees?: () => void;
  /** Fires when the user clicks Collapse-All on the file-group toolbar. */
  onCollapseAllTrees?: () => void;
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
  hasChanges = false,
  capabilities,
  showViewToggle = false,
  viewMode = "tree",
  onViewModeChange,
  onExpandAllTrees,
  onCollapseAllTrees,
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
    <div className="flex h-9 shrink-0 items-center justify-between gap-2 border-b border-border px-2">
      <span className="min-w-0 truncate text-app-label uppercase text-muted-foreground">
        Source Control
      </span>
      <div className="flex shrink-0 items-center gap-0.5">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="size-7"
          aria-label="Refresh source control"
          title="Refresh source control"
          disabled={disabled || refreshing}
          onClick={onRefresh}
        >
          <RefreshCw className={refreshing ? "size-4 animate-spin" : "size-4"} aria-hidden="true" />
        </Button>
        {showViewToggle && onViewModeChange ? (
          <ViewModeToggle
            viewMode={viewMode}
            onViewModeChange={onViewModeChange}
            disabled={disabled}
          />
        ) : null}
        {/* Expand/Collapse-all only meaningful when (1) the repo is detected
            (showViewToggle proxies that), (2) tree mode is active, and
            (3) at least one group has entries. List mode doesn't render
            directories at all so there's nothing to expand. */}
        {showViewToggle && viewMode === "tree" && onExpandAllTrees && onCollapseAllTrees ? (
          <ExpandCollapseButtons
            disabled={disabled || !hasChanges}
            onExpand={onExpandAllTrees}
            onCollapse={onCollapseAllTrees}
          />
        ) : null}
        <GitMoreMenu
          disabled={disabled}
          canInit={canInit}
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
      </div>
    </div>
  );
}
