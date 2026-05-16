// status-bar.tsx — App-wide L1 chrome status bar.
//
// Full-width horizontal bar mounted at the bottom of the App layout (sibling
// to the main content row, not inside WorkspacePanel). Height h-6 (24px).
//
// Segment layout — extendable list (future: cursor position, language, line ending):
//   LEFT:  connection status · git branch + ahead/behind · error count · warning count
//   RIGHT: git in-flight operation indicator
//
// Data sources (all reactive, never stale):
//   - activeWorkspaceId       → useActiveStore
//   - git session             → useGitSession(activeWorkspaceId)
//   - workspace connection    → useWorkspacesStore
//   - Monaco diagnostics      → useDiagnosticsStore
//
// Design:
//   - status.bar.* tokens via CSS custom properties (design.md §9)
//   - redundant encoding for errors/warnings: color + glyph (design.md §7)
//   - neutral / empty render when no workspace is selected or repo absent

import { AlertTriangle, GitBranch, Loader2, Server, XCircle } from "lucide-react";
import { cn } from "@/utils/cn";
import { useActiveStore } from "../../state/stores/active";
import { useDiagnosticsStore } from "../../state/stores/diagnostics";
import { useGitSession } from "../../state/stores/git";
import type { GitInFlightOp } from "../../state/stores/git";
import {
  selectWorkspaceConnectionStatus,
  useWorkspacesStore,
  type WorkspaceConnectionStatus,
} from "../../state/stores/workspaces";
import type { WorkspaceMeta } from "../../../shared/types/workspace";

// ---------------------------------------------------------------------------
// StatusBar root
// ---------------------------------------------------------------------------

export function StatusBar(): React.JSX.Element {
  const activeWorkspaceId = useActiveStore((s) => s.activeWorkspaceId);

  const activeWorkspace = useWorkspacesStore((s) =>
    activeWorkspaceId ? s.workspaces.find((w) => w.id === activeWorkspaceId) : undefined,
  );
  const connectionStatus = useWorkspacesStore((s) =>
    activeWorkspaceId ? selectWorkspaceConnectionStatus(s, activeWorkspaceId) : "idle",
  );

  // Git session for the active workspace — undefined when git not yet loaded
  // or workspace has no git repo.
  const gitSession = useGitSession(activeWorkspaceId ?? "");

  const errorCount = useDiagnosticsStore((s) => s.errorCount);
  const warningCount = useDiagnosticsStore((s) => s.warningCount);

  const branchInfo = gitSession?.branchInfo ?? null;
  const isRepo = gitSession?.repoInfo.kind === "repo";
  const inFlightOp = gitSession?.inFlightOp ?? null;
  const isSsh = activeWorkspace?.location.kind === "ssh";

  return (
    <div
      className="flex shrink-0 h-6 items-center border-t border-border select-none overflow-hidden"
      style={{
        backgroundColor: "var(--status-bar-bg)",
        color: "var(--status-bar-fg)",
      }}
      role="status"
      aria-label="Status bar"
    >
      {/* LEFT segments */}
      <div className="flex items-center flex-1 min-w-0">
        {/* Connection status — SSH workspaces only */}
        {isSsh && activeWorkspace && (
          <ConnectionSegment workspace={activeWorkspace} status={connectionStatus} />
        )}

        {/* Git branch + ahead/behind — when repo is active */}
        {isRepo && branchInfo && (
          <BranchSegment
            branch={branchInfo.current}
            ahead={branchInfo.ahead}
            behind={branchInfo.behind}
            isUnborn={branchInfo.isUnborn}
          />
        )}

        {/* Error count — always shown once a workspace is active (count may be 0) */}
        {activeWorkspaceId && <DiagnosticSegment kind="error" count={errorCount} />}

        {/* Warning count */}
        {activeWorkspaceId && <DiagnosticSegment kind="warning" count={warningCount} />}
      </div>

      {/* RIGHT segments */}
      <div className="flex items-center shrink-0">
        {inFlightOp && <InFlightOpSegment op={inFlightOp} />}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Connection segment (SSH only)
// ---------------------------------------------------------------------------

const CONNECTION_LABELS: Record<WorkspaceConnectionStatus, string> = {
  idle: "Disconnected",
  connecting: "Connecting…",
  connected: "Connected",
  reconnecting: "Reconnecting…",
  error: "Connection error",
};

function ConnectionSegment({
  workspace,
  status,
}: {
  workspace: WorkspaceMeta;
  status: WorkspaceConnectionStatus;
}): React.JSX.Element {
  const statusLabel = CONNECTION_LABELS[status];
  const host =
    workspace.location.kind === "ssh"
      ? (workspace.location.configAlias ??
        (workspace.location.user
          ? `${workspace.location.user}@${workspace.location.host}`
          : workspace.location.host))
      : "";

  return (
    <StatusBarItem
      title={`SSH ${statusLabel}: ${host}`}
      className={cn(
        status === "error" && "bg-[var(--status-bar-error-bg)] text-[var(--status-bar-error-fg)]",
        status === "connected" && "text-[var(--status-bar-fg)]",
        (status === "connecting" || status === "reconnecting") &&
          "text-[var(--status-bar-fg)] opacity-70",
        status === "idle" && "opacity-50",
      )}
    >
      <Server className="size-3 shrink-0" aria-hidden="true" />
      <span className="truncate max-w-32">{host || statusLabel}</span>
    </StatusBarItem>
  );
}

// ---------------------------------------------------------------------------
// Branch segment
// ---------------------------------------------------------------------------

function BranchSegment({
  branch,
  ahead,
  behind,
  isUnborn,
}: {
  branch: string;
  ahead: number;
  behind: number;
  isUnborn: boolean;
}): React.JSX.Element {
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
