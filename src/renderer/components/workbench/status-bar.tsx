// status-bar.tsx — Per-workspace status bar.
//
// Mounted at the bottom of each WorkspacePanel (not as a global app-wide bar).
// Height h-6 (24px). Receives the workspaceId of the panel it lives in.
//
// Segment layout — unified across local and SSH workspaces:
//   LEFT:  git branch (always; "no git" fallback) · error count · warning count
//   RIGHT: git in-flight operation indicator
//
// SSH connection state is conveyed by the sidebar's ConnectionStatusDot, so
// the status bar intentionally omits the account@host segment to keep a
// single layout for both local and SSH workspaces.
//
// Data sources (all reactive, never stale):
//   - workspaceId             → prop (required)
//   - git session             → useGitSession(workspaceId)
//   - Monaco diagnostics      → useDiagnosticsStore (per-workspace via selector)
//
// Git session is loaded eagerly here (loadInitial is idempotent) so the
// branch segment populates without requiring the user to open the Git panel.
// statusChanged / repoInfoChanged broadcasts keep branchInfo live afterward.
//
// Design:
//   - status.bar.* tokens via CSS custom properties (design.md §9)
//   - redundant encoding for errors/warnings: color + glyph (design.md §7)
//   - neutral / dimmed render when repo absent

import { AlertTriangle, GitBranch, Loader2, XCircle } from "lucide-react";
import { useEffect } from "react";
import { cn } from "@/utils/cn";
import type { BranchInfo } from "../../../shared/git/types";
import { selectWorkspaceDiagnostics, useDiagnosticsStore } from "../../state/stores/diagnostics";
import type { GitInFlightOp } from "../../state/stores/git";
import { useGitSession, useGitStore } from "../../state/stores/git";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface StatusBarProps {
  workspaceId: string;
}

// ---------------------------------------------------------------------------
// StatusBar root
// ---------------------------------------------------------------------------

export function StatusBar({ workspaceId }: StatusBarProps): React.JSX.Element {
  const loadInitial = useGitStore((s) => s.loadInitial);

  // Git session for this workspace — undefined until loadInitial completes.
  const gitSession = useGitSession(workspaceId);

  const { errorCount, warningCount } = useDiagnosticsStore((s) =>
    selectWorkspaceDiagnostics(s, workspaceId),
  );

  // Eagerly load the git session so the branch segment fills in without the
  // user opening the Git panel. loadInitial short-circuits when the session
  // already exists, so re-running on workspaceId changes is safe.
  useEffect(() => {
    void loadInitial(workspaceId);
  }, [loadInitial, workspaceId]);

  const isRepo = gitSession?.repoInfo.kind === "repo";
  const branchInfo = isRepo ? (gitSession?.branchInfo ?? null) : null;
  const inFlightOp = gitSession?.inFlightOp ?? null;

  return (
    <div
      className="flex shrink-0 h-6 items-center select-none overflow-hidden"
      style={{
        // No backgroundColor — the status bar is transparent so the window
        // vibrancy shows through (whole-window translucency). It is the
        // editor island's footer; the island surface shows behind it.
        color: "var(--status-bar-fg)",
      }}
      role="status"
      aria-label="Status bar"
    >
      {/* LEFT segments */}
      <div className="flex items-center flex-1 min-w-0">
        {/* Git branch — always rendered; falls back to "no git" when no repo */}
        <BranchSegment branchInfo={branchInfo} />

        {/* Error count — always shown (count may be 0) */}
        <DiagnosticSegment kind="error" count={errorCount} />

        {/* Warning count — always shown (count may be 0) */}
        <DiagnosticSegment kind="warning" count={warningCount} />
      </div>

      {/* RIGHT segments */}
      <div className="flex items-center shrink-0">
        {inFlightOp && <InFlightOpSegment op={inFlightOp} />}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Branch segment
// ---------------------------------------------------------------------------

function BranchSegment({ branchInfo }: { branchInfo: BranchInfo | null }): React.JSX.Element {
  if (!branchInfo) {
    return (
      <StatusBarItem title="No git repository" className="opacity-50">
        <GitBranch className="size-3 shrink-0" aria-hidden="true" />
        <span className="truncate max-w-40">no git</span>
      </StatusBarItem>
    );
  }

  const { current: branch, ahead, behind, isUnborn } = branchInfo;
  const aheadBehind = !isUnborn && (ahead > 0 || behind > 0) ? ` ↑${ahead} ↓${behind}` : "";
  const label = isUnborn ? `${branch} (no commits)` : `${branch}${aheadBehind}`;

  return (
    <StatusBarItem title={`Git branch: ${label}`}>
      <GitBranch className="size-3 shrink-0" aria-hidden="true" />
      <span className="truncate max-w-40">{label}</span>
    </StatusBarItem>
  );
}

// ---------------------------------------------------------------------------
// Diagnostic (error / warning) segment
// ---------------------------------------------------------------------------

function DiagnosticSegment({
  kind,
  count,
}: {
  kind: "error" | "warning";
  count: number;
}): React.JSX.Element {
  const isError = kind === "error";
  const noun = isError ? "error" : "warning";
  const title = `${count} ${noun}${count !== 1 ? "s" : ""}`;

  return (
    <StatusBarItem
      title={title}
      className={cn(
        // Redundant encoding: color + icon glyph (design.md §7 axis-4)
        count > 0 && isError && "bg-[var(--status-bar-error-bg)] text-[var(--status-bar-error-fg)]",
        count > 0 &&
          !isError &&
          "bg-[var(--status-bar-warning-bg)] text-[var(--status-bar-warning-fg)]",
      )}
    >
      {/* Glyph: provides redundant non-color encoding */}
      {isError ? (
        <XCircle className="size-3 shrink-0" aria-hidden="true" />
      ) : (
        <AlertTriangle className="size-3 shrink-0" aria-hidden="true" />
      )}
      <span>{count}</span>
    </StatusBarItem>
  );
}

// ---------------------------------------------------------------------------
// In-flight git operation segment (right side)
// ---------------------------------------------------------------------------

const OP_LABELS: Partial<Record<string, string>> = {
  stage: "Staging…",
  unstage: "Unstaging…",
  discard: "Discarding…",
  commit: "Committing…",
  fetch: "Fetching…",
  pull: "Pulling…",
  push: "Pushing…",
  pushTags: "Pushing tags…",
  sync: "Syncing…",
  stash: "Stashing…",
  stashPop: "Applying stash…",
  stashApply: "Applying stash…",
  stashDrop: "Dropping stash…",
  stashGroup: "Stashing…",
  checkout: "Checking out…",
  checkoutDetached: "Checking out…",
  checkoutTracking: "Checking out…",
  createBranch: "Creating branch…",
  deleteBranch: "Deleting branch…",
  merge: "Merging…",
  rebase: "Rebasing…",
  cherryPick: "Cherry-picking…",
  abortOp: "Aborting…",
  continueOp: "Continuing…",
  refresh: "Refreshing…",
  init: "Initializing…",
};

function InFlightOpSegment({ op }: { op: GitInFlightOp }): React.JSX.Element {
  const label = OP_LABELS[op.kind] ?? "Working…";
  return (
    <StatusBarItem title={label}>
      <Loader2 className="size-3 shrink-0 animate-spin" aria-hidden="true" />
      <span>{label}</span>
    </StatusBarItem>
  );
}

// ---------------------------------------------------------------------------
// Shared StatusBarItem primitive
// ---------------------------------------------------------------------------

interface StatusBarItemProps {
  children: React.ReactNode;
  className?: string;
  title?: string;
  /**
   * Set to true only for segments that have an onClick — hover affordance
   * should not appear on non-interactive segments (C-3: no false signifier).
   */
  interactive?: boolean;
}

function StatusBarItem({
  children,
  className,
  title,
  interactive = false,
}: StatusBarItemProps): React.JSX.Element {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex items-center gap-1 h-full px-2",
        "text-app-ui-sm font-sans leading-none",
        interactive && "hover:bg-[var(--status-bar-item-hover-bg)] transition-colors",
        className,
      )}
    >
      {children}
    </span>
  );
}
