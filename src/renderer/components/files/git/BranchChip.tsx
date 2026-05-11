/**
 * BranchChip renders the current branch plus a compact upstream delta glyph.
 * It is intentionally presentation-focused; popover and context-menu actions
 * live in GitBranchPopover so the same glyph model can be unit-tested.
 */
import { GitBranch } from "lucide-react";
import type { BranchInfo } from "../../../../shared/types/git";
import { Button } from "../../ui/button";

export interface BranchChipGlyphInput {
  readonly branch: BranchInfo | null;
}

export interface BranchChipProps extends BranchChipGlyphInput {
  readonly disabled?: boolean;
  readonly repoPath?: string;
  readonly open?: boolean;
  readonly onClick: () => void;
  readonly onContextMenu: (event: React.MouseEvent) => void;
}

/** Returns the display glyph for one upstream delta state. */
export function branchChipGlyph({ branch }: BranchChipGlyphInput): string | null {
  if (!branch?.upstream) return null;
  if (branch.ahead > 0 && branch.behind > 0) {
    return `↑${branch.ahead}↓${branch.behind}`;
  }
  if (branch.ahead > 0) return `↑${branch.ahead}`;
  if (branch.behind > 0) return `↓${branch.behind}`;
  return null;
}

/** Renders the branch chip trigger used by the footer and branch popover. */
export function BranchChip({
  branch,
  disabled = false,
  repoPath,
  open = false,
  onClick,
  onContextMenu,
}: BranchChipProps) {
  const branchName = branch?.current ?? "No branch";
  const glyph = branchChipGlyph({ branch });
  const isLocalBranch = branch != null && !branch.upstream;

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="h-11 max-w-full justify-start gap-1 px-2 text-app-ui-sm"
      aria-label={`Current branch ${branchName}`}
      aria-haspopup="dialog"
      aria-expanded={open}
      disabled={disabled || !branch}
      title={repoPath ? `Repository at ${repoPath}` : branchName}
      onClick={onClick}
      onContextMenu={onContextMenu}
    >
      <GitBranch className="size-3.5 shrink-0" aria-hidden="true" />
      <span className="truncate">{branchName}</span>
      {isLocalBranch ? (
        <span className="shrink-0 text-app-ui-sm text-muted-foreground">local</span>
      ) : null}
      {glyph ? (
        <span className="ml-1 shrink-0 font-mono text-app-ui-sm text-muted-foreground">
          {glyph}
        </span>
      ) : null}
    </Button>
  );
}
