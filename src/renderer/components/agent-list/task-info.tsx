import { ArrowDown, ArrowUp } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/utils/cn";
import type { FileLineStats } from "../../../shared/git/types";
import { showChanges, showFileChange } from "../../services/agent-sessions/actions";
import type { WorktreeEntry } from "../../services/agent-sessions/model";
import { useChangeStats, type WorktreeChanges } from "../../services/agent-sessions/use-family";

const FILES_SHOWN = 5;

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
  base: string | undefined;
  changes: WorktreeChanges | undefined;
}) {
  const { workspace } = worktree;
  const stats = useChangeStats(workspace.id, base, true);
  const path = workspace.task?.worktreePath ?? workspace.rootPath;
  const files = changes?.files ?? [];
  const shown = files.slice(0, FILES_SHOWN);
  const lines = new Map(stats?.files.map((file) => [file.path, file]));
  const total = stats && totalLines(stats.files);
  return (
    <TaskInfoLines
      label={worktree.isRoot && branch ? `${branch} · ${path}` : path}
      path={path}
      standing={
        base &&
        stats?.ahead !== undefined &&
        stats.behind !== undefined && (
          <AheadBehind ahead={stats.ahead} behind={stats.behind} base={base} />
        )
      }
      total={total && <LineCounts lines={total} className="ml-auto" />}
      files={
        changes &&
        shown.map((file) => ({
          relPath: file.relPath,
          code: file.code,
          lines: (
            <LineCounts
              lines={lines.get(file.relPath)}
              className="ml-auto @max-[200px]/agents:hidden"
            />
          ),
        }))
      }
      count={files.length}
      onOpenFile={(relPath) => showFileChange(workspace.id, relPath)}
      onShowChanges={() => showChanges(workspace.id)}
      testId="agent-list-task-info"
    />
  );
}

export function TaskInfoLines({
  label,
  path,
  standing,
  total,
  files,
  count,
  onOpenFile,
  onShowChanges,
  testId,
}: {
  label: string;
  path: string;
  standing?: ReactNode;
  total?: ReactNode;
  files: readonly { relPath: string; code: string; lines?: ReactNode }[] | undefined;
  count: number;
  onOpenFile: (relPath: string) => void;
  onShowChanges: () => void;
  testId: string;
}) {
  const { t } = useTranslation();
  const shown = files ?? [];
  return (
    <div
      className="flex min-w-0 flex-col gap-0.5 border-t border-border bg-[var(--state-hover-bg)] py-1.5 text-app-micro"
      data-testid={testId}
    >
      <div className="flex min-w-0 items-center gap-1.5 pr-3 pl-8 text-muted-foreground">
        {standing}
        <span className="min-w-0 truncate font-mono" title={path}>
          {label}
        </span>
        {total}
      </div>
      {files && count === 0 && (
        <p className="pr-3 pl-8 text-muted-foreground">{t("agentList.detail.no_changes")}</p>
      )}
      {shown.length > 0 && (
        <ul aria-label={t("agentList.detail.changes", { count })}>
          {shown.map((file) => (
            <li key={file.relPath}>
              <button
                type="button"
                title={file.relPath}
                onClick={() => onOpenFile(file.relPath)}
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
                <FilePath relPath={file.relPath} />
                {file.lines}
              </button>
            </li>
          ))}
        </ul>
      )}
      {count > shown.length && files && (
        <button
          type="button"
          onClick={onShowChanges}
          className="self-start pr-3 pl-8 text-left text-(--tab-claude-attention-fg) outline-none hover:underline focus-visible:underline"
        >
          {t("agentList.task.more_in_git", { count: count - shown.length })}
        </button>
      )}
    </div>
  );
}

function FilePath({ relPath }: { relPath: string }) {
  const slash = relPath.lastIndexOf("/");
  const name = relPath.slice(slash + 1);
  const folder = slash === -1 ? "" : relPath.slice(0, slash);
  return (
    <span className="min-w-0 truncate font-mono">
      <span className="text-foreground">{name}</span>
      {folder && <span className="ml-1.5 text-muted-foreground">{folder}</span>}
    </span>
  );
}

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

function totalLines(files: readonly FileLineStats[]): FileLineStats {
  let added = 0;
  let deleted = 0;
  for (const file of files) {
    added += file.added;
    deleted += file.deleted;
  }
  return { path: "", added, deleted };
}

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
