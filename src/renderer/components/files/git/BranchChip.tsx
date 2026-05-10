/**
 * BranchChip renders the current branch plus a compact upstream/sync glyph.
 * It is intentionally presentation-focused; popover and context-menu actions
 * live in GitBranchPopover so the same glyph model can be unit-tested.
 */
import { GitBranch } from "lucide-react";
import { useEffect, useState } from "react";
import type { BranchInfo } from "../../../../shared/types/git";
import { Button } from "../../ui/button";

const FETCHING_GLYPH_DELAY_MS = 400;

export interface BranchChipGlyphInput {
  readonly branch: BranchInfo | null;
  readonly fetching?: boolean;
  readonly failed?: boolean;
  readonly narrow?: boolean;
}

export interface BranchChipProps extends BranchChipGlyphInput {
  readonly disabled?: boolean;
  readonly repoPath?: string;
  readonly open?: boolean;
  readonly onClick: () => void;
  readonly onContextMenu: (event: React.MouseEvent) => void;
}

/** Returns the display glyph for one branch/fetch state. */
export function branchChipGlyph({
  branch,
  fetching = false,
  failed = false,
  narrow = false,
}: BranchChipGlyphInput): string {
  if (failed) return "!";
  if (fetching) return "⟳";
  if (!branch) return "⊘";
  if (!branch.upstream) return "⊘";
  if (branch.ahead > 0 && branch.behind > 0) {
    return narrow ? `↕${branch.ahead}/${branch.behind}` : `↓${branch.behind} ↑${branch.ahead}`;
  }
  if (branch.ahead > 0) return `↑${branch.ahead}`;
  if (branch.behind > 0) return `↓${branch.behind}`;
  return "∅";
}

/** Renders the branch chip trigger used by the footer and branch popover. */
export function BranchChip({
  branch,
  fetching = false,
  failed = false,
  narrow = false,
  disabled = false,
  repoPath,
  open = false,
  onClick,
  onContextMenu,
}: BranchChipProps) {
  const [showFetching, setShowFetching] = useState(false);
  useEffect(() => {
    if (!fetching) {
      setShowFetching(false);
      return;
    }
    const handle = setTimeout(() => setShowFetching(true), FETCHING_GLYPH_DELAY_MS);
    return () => clearTimeout(handle);
  }, [fetching]);

  const branchName = branch?.current ?? "No branch";
  const glyph = branchChipGlyph({ branch, fetching: showFetching, failed, narrow });

  return (
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
      onClick={onClick}
      onContextMenu={onContextMenu}
    >
      <GitBranch className="size-3.5 shrink-0" aria-hidden="true" />
      <span className="truncate">{branchName}</span>
      <span className="ml-1 shrink-0 font-mono text-app-ui-sm text-muted-foreground">{glyph}</span>
    </Button>
  );
}
