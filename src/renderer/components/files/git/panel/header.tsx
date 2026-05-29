/**
 * GitHeader renders the Source Control title and top-level action buttons.
 */
import { FoldVertical, RefreshCw, UnfoldVertical } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { GitAutofetchIntervalMin, RepoCapabilities } from "../../../../../shared/git/types";
import type { ViewMode } from "../../../../../shared/types/panel";
import { Button } from "../../../ui/button";
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
  const { t } = useTranslation("files");
  return (
    <div className="flex h-9 shrink-0 items-center justify-between gap-2 border-b border-border px-2">
      <span className="min-w-0 truncate text-app-label uppercase text-muted-foreground">
        {t("git.panel.header.title")}
      </span>
      <div className="flex shrink-0 items-center gap-0.5">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="size-7"
          aria-label={t("git.panel.header.refresh")}
          title={t("git.panel.header.refresh")}
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
        {/* Single expand/collapse toggle — icon + tooltip swap based on the
            current expanded state. Only meaningful when (1) the repo is
            detected (showViewToggle proxies that), (2) tree mode is active,
            and (3) at least one group has entries. List mode doesn't render
            directories at all so there's nothing to expand. */}
        {showViewToggle && viewMode === "tree" && onToggleAllTrees ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={hasAnyExpanded ? t("git.panel.header.collapseAll") : t("git.panel.header.expandAll")}
            title={hasAnyExpanded ? t("git.panel.header.collapseAll") : t("git.panel.header.expandAll")}
            disabled={disabled || !hasChanges}
            onClick={onToggleAllTrees}
          >
            {hasAnyExpanded ? (
              <FoldVertical aria-hidden="true" />
            ) : (
              <UnfoldVertical aria-hidden="true" />
            )}
          </Button>
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
