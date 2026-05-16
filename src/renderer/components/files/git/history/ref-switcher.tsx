/**
 * History ref switcher. It reuses BranchPicker in select-ref mode so selecting
 * a branch only retargets the log query and never checks out the working tree.
 */
import { GitBranch, RefreshCw } from "lucide-react";
import { useState } from "react";
import { Button } from "../../../ui/button";
import { BranchPicker } from "../branch/picker";

interface HistoryRefSwitcherProps {
  workspaceId: string;
  refName: string;
  searchQuery: string;
  disabled?: boolean;
  onRefChange: (refName: string) => void;
  onRefresh: () => void;
}

/** Renders the current viewed ref, explicit subtitle, and retarget picker. */
export function HistoryRefSwitcher({
  workspaceId,
  refName,
  searchQuery,
  disabled = false,
  onRefChange,
  onRefresh,
}: HistoryRefSwitcherProps) {
  const [open, setOpen] = useState(false);
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
          className="truncate px-1 text-app-ui-sm text-muted-foreground"
          aria-live="polite"
          aria-atomic="true"
        >
          Viewing history of {refName}
          {trimmedQuery.length > 0 ? <> · filtered by '{trimmedQuery}'</> : null}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-1">
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
