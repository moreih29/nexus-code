/**
 * GitGroup renders one non-empty Source Control section and its file rows.
 */
import type { GitExpandedGroupKey, GitStatusEntry } from "../../../../shared/types/git";
import { GitFileRow } from "./GitFileRow";
import { GitGroupHeader } from "./GitGroupHeader";
import { collectGitEntryPaths } from "./git-status-utils";

interface GitGroupProps {
  groupKey: GitExpandedGroupKey;
  label: string;
  entries: GitStatusEntry[];
  expanded: boolean;
  onToggle: () => void;
  onStagePaths: (paths: string[]) => void;
  onUnstagePaths: (paths: string[]) => void;
  onDiscardPaths: (paths: string[], description: string, source: GitExpandedGroupKey) => void;
  onOpenDiff: (entry: GitStatusEntry, groupKey: GitExpandedGroupKey) => void;
}

export function GitGroup({
  groupKey,
  label,
  entries,
  expanded,
  onToggle,
  onStagePaths,
  onUnstagePaths,
  onDiscardPaths,
  onOpenDiff,
}: GitGroupProps) {
  if (entries.length === 0) return null;

  const paths = collectGitEntryPaths(entries);
  const canStage = groupKey !== "staged";
  const canUnstage = groupKey === "staged";
  const discardLabel = `Discard all ${label.toLowerCase()}`;

  return (
    <section aria-label={label}>
      <GitGroupHeader
        label={label}
        count={entries.length}
        expanded={expanded}
        onToggle={onToggle}
        stageActionLabel={canStage ? `Stage all ${label.toLowerCase()}` : undefined}
        unstageActionLabel={canUnstage ? "Unstage all staged changes" : undefined}
        discardActionLabel={discardLabel}
        onStageAll={canStage ? () => onStagePaths(paths) : undefined}
        onUnstageAll={canUnstage ? () => onUnstagePaths(paths) : undefined}
        onDiscardAll={() => onDiscardPaths(paths, label, groupKey)}
      />
      {expanded ? (
        <div>
          {entries.map((entry) => (
            <GitFileRow
              key={`${groupKey}:${entry.oldRelPath ?? ""}:${entry.relPath}`}
              groupKey={groupKey}
              entry={entry}
              onOpenDiff={() => onOpenDiff(entry, groupKey)}
              onStage={canStage ? () => onStagePaths([entry.relPath]) : undefined}
              onUnstage={canUnstage ? () => onUnstagePaths([entry.relPath]) : undefined}
              onDiscard={() => onDiscardPaths([entry.relPath], entry.relPath, groupKey)}
            />
          ))}
        </div>
      ) : null}
    </section>
  );
}
