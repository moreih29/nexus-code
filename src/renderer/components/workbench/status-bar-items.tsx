import type { TFunction } from "i18next";
import {
  FileCheck,
  FileDiff,
  FilePlus,
  FileWarning,
  GitBranch,
  type LucideIcon,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/utils/cn";
import type { BranchInfo } from "../../../shared/git/types";

export function branchLabel(
  {
    current,
    ahead,
    behind,
    isUnborn,
  }: Pick<BranchInfo, "current" | "ahead" | "behind" | "isUnborn">,
  t: TFunction,
): string {
  const aheadBehind = !isUnborn && (ahead > 0 || behind > 0) ? ` ↑${ahead} ↓${behind}` : "";
  return isUnborn ? `${current} (${t("statusBar.no_commits")})` : `${current}${aheadBehind}`;
}

export function NoGitSegment({ gitMissing = false }: { gitMissing?: boolean }): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <StatusBarItem
      title={t(gitMissing ? "statusBar.git_missing_title" : "statusBar.no_git_title")}
      className="opacity-50"
    >
      <GitBranch className="size-3 shrink-0" aria-hidden="true" />
      <span className="truncate max-w-40">
        {t(gitMissing ? "statusBar.git_missing" : "statusBar.no_git")}
      </span>
    </StatusBarItem>
  );
}

export interface ChangeCounts {
  conflict: number;
  staged: number;
  modified: number;
  untracked: number;
}

export function ChangeCountsSegment({
  counts,
  onOpen,
  note,
}: {
  counts: ChangeCounts;
  onOpen: () => void;
  note?: string;
}): React.JSX.Element | null {
  const { t } = useTranslation();
  const { conflict: conflictCount, staged: stagedCount, modified: workingCount } = counts;
  const untrackedCount = counts.untracked;
  const totalCount = stagedCount + workingCount + untrackedCount + conflictCount;

  if (totalCount === 0) return null;

  const tokens: Array<{
    key: string;
    Icon: LucideIcon;
    count: number;
    color: string;
    label: string;
  }> = [];
  if (conflictCount > 0) {
    tokens.push({
      key: "conflict",
      Icon: FileWarning,
      count: conflictCount,
      color: "var(--status-bar-conflict-fg)",
      label: t("statusBar.conflict_one", { count: conflictCount }),
    });
  }
  if (stagedCount > 0) {
    tokens.push({
      key: "staged",
      Icon: FileCheck,
      count: stagedCount,
      color: "var(--status-bar-added-fg)",
      label: t("statusBar.staged", { count: stagedCount }),
    });
  }
  if (workingCount > 0) {
    tokens.push({
      key: "modified",
      Icon: FileDiff,
      count: workingCount,
      color: "var(--status-bar-modified-fg)",
      label: t("statusBar.modified", { count: workingCount }),
    });
  }
  if (untrackedCount > 0) {
    tokens.push({
      key: "untracked",
      Icon: FilePlus,
      count: untrackedCount,
      color: "var(--status-bar-untracked-fg)",
      label: t("statusBar.untracked", { count: untrackedCount }),
    });
  }

  const summary = [tokens.map((tok) => tok.label).join(", "), note].filter(Boolean).join(" · ");
  const title = t("statusBar.changes_title", { summary });

  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onOpen}
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap h-full px-2",
        "text-app-ui-sm font-sans leading-none tabular-nums",
        "hover:bg-[var(--status-bar-item-hover-bg)] focus-visible:bg-[var(--status-bar-item-hover-bg)] focus-visible:outline-none transition-colors",
      )}
    >
      {tokens.map(({ key, Icon, count, color }) => (
        <span key={key} style={{ color }} className="inline-flex items-center gap-1">
          <Icon aria-hidden="true" className="size-3.5" />
          <span>{count}</span>
        </span>
      ))}
    </button>
  );
}

interface StatusBarItemProps {
  children: React.ReactNode;
  className?: string;
  title?: string;
  interactive?: boolean;
}

export function StatusBarItem({
  children,
  className,
  title,
  interactive = false,
}: StatusBarItemProps): React.JSX.Element {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex min-w-0 items-center gap-1 whitespace-nowrap h-full px-2",
        "text-app-ui-sm font-sans leading-none",
        interactive && "hover:bg-[var(--status-bar-item-hover-bg)] transition-colors",
        className,
      )}
    >
      {children}
    </span>
  );
}
