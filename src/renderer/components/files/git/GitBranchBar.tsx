/**
 * GitBranchBar renders the panel footer with branch and sync affordances.
 */
import type { BranchInfo } from "../../../../shared/types/git";
import { Button } from "../../ui/button";
import { GitBranchPopover } from "./GitBranchPopover";

interface GitBranchBarProps {
  branch: BranchInfo | null;
  repoPath?: string;
  disabled?: boolean;
  onSync: () => void;
  onSwitchBranch: () => void;
}

function syncLabel(branch: BranchInfo | null): string {
  if (!branch) return "No branch";
  if (branch.ahead > 0 && branch.behind > 0) return "Sync";
  if (branch.ahead > 0) return "Push";
  if (branch.behind > 0) return "Pull";
  return "Up to date";
}

export function GitBranchBar({
  branch,
  repoPath,
  disabled = false,
  onSync,
  onSwitchBranch,
}: GitBranchBarProps) {
  const hasRemoteDelta = Boolean(branch && (branch.ahead > 0 || branch.behind > 0));
  const label = syncLabel(branch);

  return (
    <div className="flex h-7 shrink-0 items-center gap-1 border-t border-mist-border bg-frosted-veil px-1 text-app-ui-sm text-muted-foreground">
      <GitBranchPopover
        branch={branch}
        repoPath={repoPath}
        disabled={disabled}
        onSwitchBranch={onSwitchBranch}
      />
      {branch && (branch.behind > 0 || branch.ahead > 0) ? (
        <span className="shrink-0 font-mono text-app-ui-sm text-muted-foreground">
          {branch.behind > 0 ? `↓${branch.behind}` : ""}
          {branch.behind > 0 && branch.ahead > 0 ? " " : ""}
          {branch.ahead > 0 ? `↑${branch.ahead}` : ""}
        </span>
      ) : null}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-6 shrink-0 px-2 text-app-ui-sm"
        disabled={disabled || !hasRemoteDelta}
        title={hasRemoteDelta ? label : "Up to date"}
        onClick={onSync}
      >
        {label}
      </Button>
    </div>
  );
}
