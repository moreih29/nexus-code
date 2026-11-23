import { ChevronRight, Minus, Plus, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/utils/cn";
import type { GitExpandedGroupKey, GitStatusEntry } from "../../../../../shared/git/types";
import { Button } from "../../../ui/button";
import { tooltipProps } from "../../../ui/tooltip";
import { FileIcon } from "../../file-tree/file-icon";
import {
  type GitDecorationKind,
  kindToColorVar,
  kindToLetter,
} from "../../file-tree/git-decoration";
import { INDENT_STEP_PX } from "../../file-tree/metrics";
import { type GitFileActions, GitFileRow } from "./row";

interface GitTreeRowBase {
  depth: number;
  groupKey: GitExpandedGroupKey;
  treeItemProps: React.HTMLAttributes<HTMLElement>;
  onFocus?: () => void;
}

interface GitTreeRowDirProps extends GitTreeRowBase {
  kind: "dir";
  displayName: string;
  relPath: string;
  isExpanded: boolean;
  decoration?: GitDecorationKind;
  onToggle: () => void;
  onStagePaths?: () => void;
  onUnstagePaths?: () => void;
  onDiscardPaths?: () => void;
}

interface GitTreeRowLeafProps extends GitTreeRowBase {
  kind: "leaf";
  entry: GitStatusEntry;
  actions: GitFileActions;
}

export type GitTreeRowProps = GitTreeRowDirProps | GitTreeRowLeafProps;

export function GitTreeRow(props: GitTreeRowProps) {
  const { t } = useTranslation("files");
  const { depth, treeItemProps, onFocus } = props;
  const indentLeft = (depth - 1) * INDENT_STEP_PX + 8;

  if (props.kind === "dir") {
    const {
      displayName,
      isExpanded,
      decoration,
      onToggle,
      onStagePaths,
      onUnstagePaths,
      onDiscardPaths,
    } = props;
    return (
      <div
        {...treeItemProps}
        role="treeitem"
        aria-expanded={isExpanded}
        className="group flex h-6 w-full cursor-pointer items-center gap-1 pr-1 text-app-body text-foreground hover:bg-[var(--state-hover-bg)] focus-visible:bg-[var(--state-hover-bg)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
        style={{ paddingLeft: indentLeft }}
        onClick={onToggle}
        onFocus={onFocus}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onToggle();
          }
        }}
        tabIndex={treeItemProps.tabIndex ?? -1}
      >
        <ChevronRight
          className={cn(
            "size-3 shrink-0 text-muted-foreground transition-transform duration-150 ease-out",
            isExpanded && "rotate-90",
          )}
          aria-hidden="true"
        />
        <FileIcon
          kind={isExpanded ? "folder-open" : "folder"}
          size="md"
          tone="muted"
          className="shrink-0"
          aria-hidden="true"
        />
        <span className="min-w-0 flex-1 truncate">{displayName}</span>
        <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
          {onStagePaths ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="size-6"
              tooltip={t("git.fileRow.stageFolder", { name: displayName })}
              onClick={(event) => {
                event.stopPropagation();
                onStagePaths();
              }}
            >
              <Plus className="size-3.5" aria-hidden="true" />
            </Button>
          ) : null}
          {onUnstagePaths ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="size-6"
              tooltip={t("git.fileRow.unstageFolder", { name: displayName })}
              onClick={(event) => {
                event.stopPropagation();
                onUnstagePaths();
              }}
            >
              <Minus className="size-3.5" aria-hidden="true" />
            </Button>
          ) : null}
          {onDiscardPaths ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="size-6 opacity-50 transition-opacity hover:opacity-100 git-destructive-text"
              tooltip={t("git.fileRow.discardFolder", { name: displayName })}
              onClick={(event) => {
                event.stopPropagation();
                onDiscardPaths();
              }}
            >
              <Trash2 className="size-3.5" aria-hidden="true" />
            </Button>
          ) : null}
        </div>
        {decoration !== undefined && (
          <span
            className="inline-flex shrink-0 items-center justify-center pl-1 pr-1 font-mono text-app-ui-sm leading-none"
            style={{ color: kindToColorVar(decoration) }}
            role="img"
            aria-label={`Git ${t(`git.decorations.${decoration}`)}`}
            {...tooltipProps(t(`git.decorations.${decoration}`))}
          >
            {kindToLetter(decoration)}
          </span>
        )}
      </div>
    );
  }

  const { entry, groupKey, actions } = props;

  return (
    <div
      {...treeItemProps}
      role="treeitem"
      style={{ paddingLeft: indentLeft }}
      onFocus={onFocus}
      tabIndex={treeItemProps.tabIndex ?? -1}
    >
      <GitFileRow groupKey={groupKey} entry={entry} actions={actions} />
    </div>
  );
}
