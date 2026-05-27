// status-bar.tsx — Per-workspace status bar.
//
// Mounted at the bottom of each WorkspacePanel (not as a global app-wide bar).
// Height h-6 (24px). Receives the workspaceId of the panel it lives in.
//
// Segment layout — unified across local and SSH workspaces:
//   LEFT:  git branch · changes (+~?!) · error count · warning count
//   RIGHT: git in-flight operation indicator
//
// The changes segment renders inline with the branch button (separate click
// target) and shows only the non-zero tokens; the whole segment disappears in
// a clean tree. Clicking it switches the files panel to Source Control —
// consistent with how diagnostic counts open their popover.
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
// Diagnostic segments:
//   - VSCode-style glyph + count, no background fill. Color (red/amber) is
//     applied to icon + count text only; zero-count segments are dimmed.
//   - Clicking a non-zero segment opens a popover listing each diagnostic
//     grouped by file. Clicking a row opens the file at that line.
//
// Design:
//   - status.bar.* tokens via CSS custom properties (design.md §9)
//   - redundant encoding for errors/warnings: color + glyph (design.md §7)
//   - neutral / dimmed render when repo absent

import { AlertTriangle, GitBranch, Loader2, XCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { cn } from "@/utils/cn";
import type { BranchInfo, GitStatus } from "../../../shared/git/types";
import { selectWorkspaceDiagnostics, useDiagnosticsStore } from "../../state/stores/diagnostics";
import type { GitInFlightOp } from "../../state/stores/git";
import { useGitSession, useGitStore } from "../../state/stores/git";
import { useUIStore } from "../../state/stores/ui";
import { BranchPicker } from "../files/git/branch/picker";
import { type DiagnosticKind, DiagnosticPopover } from "./diagnostic-popover";

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
  // Status groups feed the +~?! changes segment. Null when the workspace is
  // not a repo or the first status fetch hasn't landed yet — the segment
  // gracefully renders nothing in that case.
  const status = isRepo ? (gitSession?.status ?? null) : null;
  const inFlightOp = gitSession?.inFlightOp ?? null;

  return (
    <div
      // No overflow-hidden — diagnostic popovers anchor at `bottom-full` and
      // extend upward into the editor area. The WorkspacePanel root keeps
      // overflow-hidden to bound visual leaks within the panel, so removing
      // it here just unclips the popover without losing layout containment.
      // Each segment already truncates its own text, so the row stays sized.
      className="relative flex shrink-0 h-6 items-center select-none"
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
        {/* Git branch — clickable when a repo is present (opens the switch
            branch picker); dimmed "no git" placeholder otherwise. */}
        <BranchSegment workspaceId={workspaceId} branchInfo={branchInfo} />

        {/* Branch changes (+ staged · ~ modified · ? untracked · ! conflict).
            Renders nothing when the tree is clean or status hasn't loaded. */}
        <ChangesSegment workspaceId={workspaceId} status={status} />

        {/* Error count — clickable when count > 0, opens a popover list */}
        <DiagnosticSegment kind="error" count={errorCount} workspaceId={workspaceId} />

        {/* Warning count — same treatment as errors */}
        <DiagnosticSegment kind="warning" count={warningCount} workspaceId={workspaceId} />
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
//
// When the workspace is a git repo with a known branch the segment is a
// button that opens the existing BranchPicker (switch mode = checkout).
// When the workspace has no repo (or repo is still detecting), the segment
// renders as a dimmed, non-interactive "no git" placeholder.
// ---------------------------------------------------------------------------

function BranchSegment({
  workspaceId,
  branchInfo,
}: {
  workspaceId: string;
  branchInfo: BranchInfo | null;
}): React.JSX.Element {
  const [pickerOpen, setPickerOpen] = useState(false);

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
    <>
      <button
        type="button"
        title={`Git branch: ${label} — click to switch`}
        aria-label={`Switch branch (currently ${label})`}
        onClick={() => setPickerOpen(true)}
        className={cn(
          "inline-flex items-center gap-1 h-full px-2",
          "text-app-ui-sm font-sans leading-none",
          "hover:bg-[var(--status-bar-item-hover-bg)] focus-visible:bg-[var(--status-bar-item-hover-bg)] focus-visible:outline-none transition-colors",
        )}
      >
        <GitBranch className="size-3 shrink-0" aria-hidden="true" />
        <span className="truncate max-w-40">{label}</span>
      </button>
      {/* BranchPicker is controlled; mounting it always while keeping `open`
          off lets the picker's internal source/state initialise lazily on
          first open without re-creating dialogs each toggle. */}
      <BranchPicker
        workspaceId={workspaceId}
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// Changes segment
//
// Renders the branch's working state as colored count tokens next to the
// branch button. Follows the +~?! convention shared with git-prompt.sh /
// posh-git / vim-airline / Starship so users transferring from those
// environments read it without learning a new notation:
//
//   +N  staged    — index has N changes ready to commit       (success hue)
//   ~N  modified  — working tree has N unstaged modify/delete (warning hue)
//   ?N  untracked — N new files git does not yet know about   (info hue)
//   !N  conflict  — N files in merge conflict (rendered FIRST) (error hue)
//
// Empty tokens are omitted (0 count → no chip), and a fully clean tree
// hides the whole segment so the status bar stays quiet during steady
// state. Conflict tokens lead so position itself signals priority
// (design.md §7 redundant encoding: color + position + glyph).
//
// Click target: opens the Source Control panel via setFilesPanelMode. This
// matches diagnostic segment semantics — counts are summaries; the panel
// is where action happens. The whole segment is a single button so the
// click area is comfortable even on a 24px-tall bar.
// ---------------------------------------------------------------------------

function ChangesSegment({
  workspaceId,
  status,
}: {
  workspaceId: string;
  status: GitStatus | null;
}): React.JSX.Element | null {
  const setFilesPanelMode = useUIStore((s) => s.setFilesPanelMode);

  if (!status) return null;

  const stagedCount = status.staged.length;
  const workingCount = status.working.length;
  const untrackedCount = status.untracked.length;
  const conflictCount = status.merge.length;
  const totalCount = stagedCount + workingCount + untrackedCount + conflictCount;

  // Clean tree — hide the whole segment so the bar reads "quiet" on idle.
  if (totalCount === 0) return null;

  // Tokens, in render order. Conflicts lead so the most urgent state is
  // the first thing the eye reaches after the branch name.
  const tokens: Array<{ glyph: string; count: number; color: string; label: string }> = [];
  if (conflictCount > 0) {
    tokens.push({
      glyph: "!",
      count: conflictCount,
      color: "var(--status-bar-conflict-fg)",
      label: `${conflictCount} unresolved conflict${conflictCount === 1 ? "" : "s"}`,
    });
  }
  if (stagedCount > 0) {
    tokens.push({
      glyph: "+",
      count: stagedCount,
      color: "var(--status-bar-added-fg)",
      label: `${stagedCount} staged`,
    });
  }
  if (workingCount > 0) {
    tokens.push({
      glyph: "~",
      count: workingCount,
      color: "var(--status-bar-modified-fg)",
      label: `${workingCount} modified`,
    });
  }
  if (untrackedCount > 0) {
    tokens.push({
      glyph: "?",
      count: untrackedCount,
      color: "var(--status-bar-untracked-fg)",
      label: `${untrackedCount} untracked`,
    });
  }

  const title = `${tokens.map((t) => t.label).join(", ")} — click to open Source Control`;

  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={() => setFilesPanelMode(workspaceId, "git")}
      className={cn(
        "inline-flex items-center gap-1.5 h-full px-2",
        "text-app-ui-sm font-sans leading-none tabular-nums",
        "hover:bg-[var(--status-bar-item-hover-bg)] focus-visible:bg-[var(--status-bar-item-hover-bg)] focus-visible:outline-none transition-colors",
      )}
    >
      {tokens.map((t) => (
        <span key={t.glyph} style={{ color: t.color }} className="inline-flex items-baseline">
          <span aria-hidden="true">{t.glyph}</span>
          <span>{t.count}</span>
        </span>
      ))}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Diagnostic (error / warning) segment
//
// Visual: glyph + count, color (red/amber) applied to the icon and number
// only — no background fill. Zero-count segments are dimmed and not
// interactive (no popover to show). Color tokens reuse
// --status-bar-{kind}-bg as the glyph foreground; the "bg" name predates
// the glyph-only style and refers to the saturated hue, not a fill role.
//
// Interaction: clicking a non-zero segment opens a popover listing the
// diagnostics grouped by file. The trigger and popover share a wrapper
// div so useDismissOnOutsideClick treats clicks on either as "inside".
// ---------------------------------------------------------------------------

function DiagnosticSegment({
  kind,
  count,
  workspaceId,
}: {
  kind: DiagnosticKind;
  count: number;
  workspaceId: string;
}): React.JSX.Element {
  const isError = kind === "error";
  const noun = isError ? "error" : "warning";
  const title = `${count} ${noun}${count !== 1 ? "s" : ""}`;
  const Icon = isError ? XCircle : AlertTriangle;
  const glyphColor = isError ? "var(--status-bar-error-bg)" : "var(--status-bar-warning-bg)";

  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const disabled = count === 0;

  // If the count drops to zero while the popover is open, close it. The
  // popover itself also self-closes when its list goes empty, but driving
  // the trigger state here keeps aria-expanded honest.
  useEffect(() => {
    if (disabled && open) setOpen(false);
  }, [disabled, open]);

  return (
    <div ref={wrapperRef} className="relative inline-flex h-full">
      <button
        type="button"
        title={title}
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={title}
        onClick={() => {
          if (!disabled) setOpen((v) => !v);
        }}
        className={cn(
          "inline-flex items-center gap-1 h-full px-2",
          "text-app-ui-sm font-sans leading-none",
          // Hover/focus affordance only when interactive.
          !disabled &&
            "hover:bg-[var(--status-bar-item-hover-bg)] focus-visible:bg-[var(--status-bar-item-hover-bg)] focus-visible:outline-none transition-colors",
          // Dim the entire segment to muted-foreground when there's nothing
          // to look at; keep the segment visible so the user can read "0".
          disabled && "text-muted-foreground/70 cursor-default",
        )}
      >
        <Icon
          className="size-3 shrink-0"
          // Glyph color: keep the severity hue even at count=0 so the icon
          // reads as "error slot" / "warning slot"; dim via opacity rather
          // than swapping color so the meaning stays consistent.
          style={{ color: glyphColor, opacity: disabled ? 0.45 : 1 }}
          aria-hidden="true"
        />
        <span style={!disabled ? { color: glyphColor } : undefined}>{count}</span>
      </button>
      {open ? (
        <DiagnosticPopover
          workspaceId={workspaceId}
          kind={kind}
          wrapperRef={wrapperRef}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </div>
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
