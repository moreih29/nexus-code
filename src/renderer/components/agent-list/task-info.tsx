// Agent list — a worktree's facts, unfolded under its header in the task
// view: how far a task has gone from its workspace's branch, its folder,
// and its uncommitted changes in lines, the first few files of them; a file
// opens its diff, the rest is in source control.

import { ArrowDown, ArrowUp } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/utils/cn";
import type { FileLineStats } from "../../../shared/git/types";
import { showChanges, showFileChange } from "../../services/agent-sessions/actions";
import type { WorktreeEntry } from "../../services/agent-sessions/model";
import { useChangeStats, type WorktreeChanges } from "../../services/agent-sessions/use-family";

/** How many changed files show before "N more". */
const FILES_SHOWN = 5;

/** How each change's letter is tinted: added green, deleted red, modified amber. */
const CODE_TINT: Record<string, string> = {
  A: "text-emerald-500",
  "?": "text-emerald-500",
  D: "text-(--state-error-fg)",
  U: "text-(--state-error-fg)",
  M: "text-(--state-warning-fg)",
  R: "text-(--state-info-fg)",
  C: "text-(--state-info-fg)",
};

export function TaskInfo({
  worktree,
  branch,
  base,
  changes,
}: {
  worktree: WorktreeEntry;
  branch: string | undefined;
  /** The workspace's branch, which a task is compared with. */
  base: string | undefined;
  changes: WorktreeChanges | undefined;
}) {
  const { t } = useTranslation();
  const { workspace } = worktree;
  // Read only while it is unfolded, as the detail panel read it while shown.
  const stats = useChangeStats(workspace.id, base, true);
  const path = workspace.task?.worktreePath ?? workspace.rootPath;
  const files = changes?.files ?? [];
  const shown = files.slice(0, FILES_SHOWN);
  const lines = new Map(stats?.files.map((file) => [file.path, file]));
  const total = stats && totalLines(stats.files);
  return (
    <div
      className="flex min-w-0 flex-col gap-0.5 border-t border-border bg-[var(--state-hover-bg)] py-1.5 text-app-micro"
      data-testid="agent-list-task-info"
    >
      <div className="flex min-w-0 items-center gap-1.5 pr-3 pl-8 text-muted-foreground">
        {base && stats?.ahead !== undefined && stats.behind !== undefined && (
          <AheadBehind ahead={stats.ahead} behind={stats.behind} base={base} />
        )}
        <span className="min-w-0 truncate font-mono" title={path}>
          {worktree.isRoot && branch ? `${branch} · ${path}` : path}
        </span>
        {total && <LineCounts lines={total} className="ml-auto" />}
      </div>
      {changes && files.length === 0 && (
        <p className="pr-3 pl-8 text-muted-foreground">{t("agentList.detail.no_changes")}</p>
      )}
      {shown.length > 0 && (
        <ul aria-label={t("agentList.detail.changes", { count: files.length })}>
          {shown.map((file) => (
            <li key={file.relPath}>
              <button
                type="button"
                title={file.relPath}
                onClick={() => showFileChange(workspace.id, file.relPath)}
                className="flex w-full min-w-0 items-center gap-2 py-0.5 pr-3 pl-8 text-left transition-colors outline-none hover:bg-[var(--state-hover-bg)] focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset"
              >
                <span
                  className={cn(
                    "w-2.5 shrink-0 font-mono",
                    CODE_TINT[file.code] ?? "text-muted-foreground",
                  )}
                >
                  {file.code}
                </span>
                <span className="min-w-0 truncate font-mono text-foreground">{file.relPath}</span>
                <LineCounts lines={lines.get(file.relPath)} className="ml-auto" />
              </button>
            </li>
          ))}
        </ul>
      )}
      {files.length > shown.length && (
        <button
          type="button"
          onClick={() => showChanges(workspace.id)}
          className="self-start pr-3 pl-8 text-left text-(--tab-claude-attention-fg) outline-none hover:underline focus-visible:underline"
        >
          {t("agentList.task.more_in_git", { count: files.length - shown.length })}
        </button>
      )}
    </div>
  );
}

/** A task's commits ahead of and behind its workspace's branch, as ↑2 ↓1 vs main. */
function AheadBehind({ ahead, behind, base }: { ahead: number; behind: number; base: string }) {
  const { t } = useTranslation();
  return (
    <span
      className="flex shrink-0 items-center gap-1.5 tabular-nums"
      title={t("agentList.detail.ahead_behind", { ahead, behind, branch: base })}
      data-testid="task-ahead-behind"
    >
      <span className="flex items-center">
        <ArrowUp aria-hidden className="size-3" />
        {ahead}
      </span>
      <span className="flex items-center">
        <ArrowDown aria-hidden className="size-3" />
        {behind}
      </span>
    </span>
  );
}

/** The lines all the files add and delete. */
function totalLines(files: readonly FileLineStats[]): FileLineStats {
  let added = 0;
  let deleted = 0;
  for (const file of files) {
    added += file.added;
    deleted += file.deleted;
  }
  return { path: "", added, deleted };
}

/** +12 −3, the parts that are not zero; "binary" for a binary file. */
function LineCounts({
  lines,
  className,
}: {
  lines: FileLineStats | undefined;
  className?: string;
}) {
  const { t } = useTranslation();
  if (!lines) return null;
  if (lines.binary) {
    return (
      <span className={cn("shrink-0 text-muted-foreground", className)}>
        {t("agentList.detail.binary")}
      </span>
    );
  }
  if (lines.added === 0 && lines.deleted === 0) return null;
  return (
    <span
      className={cn("flex shrink-0 gap-1.5 font-mono tabular-nums", className)}
      title={t("agentList.detail.lines", { added: lines.added, deleted: lines.deleted })}
    >
      {lines.added > 0 && <span className="text-emerald-500">+{lines.added}</span>}
      {lines.deleted > 0 && <span className="text-(--state-error-fg)">{`−${lines.deleted}`}</span>}
    </span>
  );
}
