/**
 * GitHeader renders the Source Control title and top-level action buttons.
 */
import { RefreshCw } from "lucide-react";
import type { GitAutofetchIntervalMin, RepoCapabilities } from "../../../../shared/types/git";
import type { ViewMode } from "../../../../shared/types/panel";
import { Button } from "../../ui/button";
import { ViewModeToggle } from "../view-mode-toggle/ViewModeToggle";
import { GitMoreMenu } from "./GitMoreMenu";

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
  compactFolders?: boolean;
  onViewModeChange?: (next: ViewMode) => void;
  onCompactFoldersChange?: (next: boolean) => void;
  onRefresh: () => void;
  onInit: () => void;
  onFetch: () => void;
  onPull: () => void;
  onPush: () => void;
  onStash: () => void;
  onStashPop: () => void;
  onOpenStashes: () => void;
  onOpenTags: () => void;
  onSwitchBranch: () => void;
  onMergeBranch: () => void;
  onRebaseBranch: () => void;
  onCherryPick: () => void;
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
  compactFolders = false,
  onViewModeChange,
  onCompactFoldersChange,
  onRefresh,
  onInit,
  onFetch,
  onPull,
  onPush,
  onStash,
  onStashPop,
  onOpenStashes,
  onOpenTags,
  onSwitchBranch,
  onMergeBranch,
  onRebaseBranch,
  onCherryPick,
  onAddRemote,
  onRemoveRemote,
  onDiscardAll,
  autofetchIntervalMin,
  lastFetchedAt,
  onSetAutofetchInterval,
}: GitHeaderProps) {
  return (
    <div className="flex h-8 shrink-0 items-center justify-between gap-2 border-b border-mist-border px-2">
      <span className="min-w-0 truncate text-small-label uppercase text-muted-foreground">
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
            compactFolders={compactFolders}
            onCompactChange={onCompactFoldersChange}
            disabled={disabled}
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
          onOpenTags={onOpenTags}
          onSwitchBranch={onSwitchBranch}
          onMergeBranch={onMergeBranch}
          onRebaseBranch={onRebaseBranch}
          onCherryPick={onCherryPick}
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
