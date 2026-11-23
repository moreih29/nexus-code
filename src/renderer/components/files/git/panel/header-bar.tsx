import { ChevronsDownUp, ChevronsUpDown, RefreshCw } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { ViewMode } from "../../../../../shared/types/panel";
import { Button } from "../../../ui/button";
import { ViewModeToggle } from "../../view-mode-toggle";

export interface GitHeaderBarProps {
  disabled?: boolean;
  refreshing?: boolean;
  hasChanges?: boolean;
  showViewToggle?: boolean;
  viewMode?: ViewMode;
  onViewModeChange?: (next: ViewMode) => void;
  hasAnyExpanded?: boolean;
  onToggleAllTrees?: () => void;
  onRefresh: () => void;
  children?: ReactNode;
}

export function GitHeaderBar({
  disabled = false,
  refreshing = false,
  hasChanges = false,
  showViewToggle = false,
  viewMode = "tree",
  onViewModeChange,
  hasAnyExpanded = false,
  onToggleAllTrees,
  onRefresh,
  children,
}: GitHeaderBarProps) {
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
        {showViewToggle && viewMode === "tree" && onToggleAllTrees ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={
              hasAnyExpanded ? t("git.panel.header.collapseAll") : t("git.panel.header.expandAll")
            }
            title={
              hasAnyExpanded ? t("git.panel.header.collapseAll") : t("git.panel.header.expandAll")
            }
            disabled={disabled || !hasChanges}
            onClick={onToggleAllTrees}
          >
            {hasAnyExpanded ? (
              <ChevronsDownUp aria-hidden="true" />
            ) : (
              <ChevronsUpDown aria-hidden="true" />
            )}
          </Button>
        ) : null}
        {children}
      </div>
    </div>
  );
}
