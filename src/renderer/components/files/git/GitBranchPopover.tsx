/**
 * GitBranchPopover shows current branch details and simple branch actions.
 */
import { GitBranch } from "lucide-react";
import { useState } from "react";
import type { BranchInfo } from "../../../../shared/types/git";
import { Button } from "../../ui/button";

interface GitBranchPopoverProps {
  branch: BranchInfo | null;
  repoPath?: string;
  disabled?: boolean;
  onCheckout: () => void;
  onCreateBranch: () => void;
}

export function GitBranchPopover({
  branch,
  repoPath,
  disabled = false,
  onCheckout,
  onCreateBranch,
}: GitBranchPopoverProps) {
  const [open, setOpen] = useState(false);
  const branchName = branch?.current ?? "No branch";

  function run(action: () => void): void {
    setOpen(false);
    action();
  }

  return (
    <div className="relative min-w-0 flex-1">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7 max-w-full justify-start gap-1 px-2 text-app-ui-sm"
        aria-label={`Current branch ${branchName}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={disabled || !branch}
        title={repoPath ? `Repository at ${repoPath}` : branchName}
        onClick={() => setOpen((value) => !value)}
      >
        <GitBranch className="size-3.5 shrink-0" aria-hidden="true" />
        <span className="truncate">{branchName}</span>
      </Button>
      {open ? (
        <div
          role="dialog"
          aria-label="Branch details"
          className="absolute bottom-8 left-0 z-40 w-[240px] rounded border border-mist-border bg-popover p-2 text-popover-foreground shadow-sm"
          onKeyDown={(event) => {
            if (event.key === "Escape") setOpen(false);
          }}
        >
          <p className="truncate text-app-body text-foreground" title={branchName}>
            {branchName}
          </p>
          {branch?.upstream ? (
            <p
              className="mt-0.5 truncate text-app-ui-sm text-muted-foreground"
              title={branch.upstream}
            >
              Tracking {branch.upstream}
            </p>
          ) : (
            <p className="mt-0.5 text-app-ui-sm text-muted-foreground">No upstream configured</p>
          )}
          {repoPath ? (
            <p className="mt-1 truncate text-app-ui-sm text-muted-foreground" title={repoPath}>
              {repoPath}
            </p>
          ) : null}
          <div className="mt-2 flex gap-1">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 flex-1 text-app-ui-sm"
              onClick={() => run(onCheckout)}
            >
              Checkout…
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 flex-1 text-app-ui-sm"
              onClick={() => run(onCreateBranch)}
            >
              New…
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
