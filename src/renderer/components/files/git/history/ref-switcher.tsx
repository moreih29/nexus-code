/**
 * History ref switcher. It reuses BranchPicker in select-ref mode so selecting
 * a branch only retargets the log query and never checks out the working tree.
 */
import { GitBranch, Network, RefreshCw } from "lucide-react";
import { useState } from "react";
import type { GitHistoryScope } from "../../../../../shared/git/types";
import { cn } from "../../../../utils/cn";
import { Button } from "../../../ui/button";
import { BranchPicker } from "../branch/picker";

const HISTORY_SCOPE_TOGGLE_ON_CLASS =
  "bg-[var(--state-active-bg)] text-foreground ring-1 ring-inset ring-ring";

interface HistoryRefSwitcherProps {
  workspaceId: string;
  refName: string;
  historyScope: GitHistoryScope;
  searchQuery: string;
  disabled?: boolean;
  onRefChange: (refName: string) => void;
  onScopeChange: (scope: GitHistoryScope) => void;
  onRefresh: () => void;
}

/** Renders the current viewed ref, explicit subtitle, and retarget picker. */
export function HistoryRefSwitcher({
  workspaceId,
  refName,
  historyScope,
  searchQuery,
  disabled = false,
  onRefChange,
  onScopeChange,
  onRefresh,
}: HistoryRefSwitcherProps) {
  const [open, setOpen] = useState(false);
  const allBranches = historyScope === "all";
  const trimmedQuery = searchQuery.trim();

  return (
    <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-2 py-2">
      <div className="min-w-0">
        <button
          type="button"
          disabled={disabled}
          className="flex min-w-0 items-center gap-1 rounded px-1 py-0.5 text-left text-app-ui text-foreground hover:bg-[var(--state-hover-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-50"
          onClick={() => setOpen(true)}
        >
          <GitBranch className="size-3.5 shrink-0" aria-hidden="true" />
          <span className="truncate">{refName}</span>
        </button>
        <p
          className="truncate px-1 text-app-ui-xs text-muted-foreground"
          aria-live="polite"
          aria-atomic="true"
        >
          {allBranches ? (
            trimmedQuery.length > 0 ? (
              <>Viewing all branches · filtered by '{trimmedQuery}'</>
            ) : (
              <>
                <span className="text-foreground">Viewing all branches</span>
                {refName ? <span> · was: {refName}</span> : null}
              </>
            )
          ) : (
            <>
              Viewing history of {refName}
              {trimmedQuery.length > 0 ? <> · filtered by '{trimmedQuery}'</> : null}
            </>
          )}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className={cn("size-7", allBranches && HISTORY_SCOPE_TOGGLE_ON_CLASS)}
          disabled={disabled}
          aria-label="Show all branches"
          aria-pressed={allBranches}
          title="Show all branches"
          onClick={() => onScopeChange(allBranches ? "ref" : "all")}
        >
          <Network className="size-3.5" aria-hidden="true" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="size-7"
          disabled={disabled}
          aria-label="Refresh history"
          title="Refresh history"
          onClick={onRefresh}
        >
          <RefreshCw className="size-3.5" aria-hidden="true" />
        </Button>
      </div>
      <BranchPicker
        workspaceId={workspaceId}
        open={open}
        mode="select-ref"
        title="View history of"
        placeholder="Select a branch to view history…"
        footer="Enter view history · does not checkout"
        onClose={() => setOpen(false)}
        onSelectRef={(nextRef) => {
          setOpen(false);
          onRefChange(nextRef);
        }}
      />
    </div>
  );
}
