import { AlertTriangle, GitBranch, Loader2, XCircle } from "lucide-react";
import { memo, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/utils/cn";
import type { BranchInfo, GitStatus } from "../../../shared/git/types";
import { selectWorkspaceDiagnostics, useDiagnosticsStore } from "../../state/stores/diagnostics";
import type { GitInFlightOp } from "../../state/stores/git";
import { useGitSession, useGitStore } from "../../state/stores/git";
import { useUIStore } from "../../state/stores/ui";
import { BranchPicker } from "../files/git/branch/picker";
import { Popover } from "../ui/popover";
import { type DiagnosticKind, DiagnosticList } from "./diagnostic-popover";
import { EncodingSegment } from "./encoding-segment";
import { LspStatusSegment } from "./lsp-status-segment";
import { PortsSegment } from "./ports-segment";
import { branchLabel, ChangeCountsSegment, NoGitSegment, StatusBarItem } from "./status-bar-items";
import { STATS_MIN_WIDTH, SystemStatsSegment, useWiderThan } from "./system-stats";

const PORTS_MIN_WIDTH = 440;
const EDITOR_SEGMENTS_MIN_WIDTH = 300;

interface StatusBarProps {
  workspaceId: string;
}

export const StatusBar = memo(function StatusBar({
  workspaceId,
}: StatusBarProps): React.JSX.Element {
  const { t } = useTranslation();
  const loadInitial = useGitStore((s) => s.loadInitial);

  const gitSession = useGitSession(workspaceId);

  const { errorCount, warningCount } = useDiagnosticsStore((s) =>
    selectWorkspaceDiagnostics(s, workspaceId),
  );

  useEffect(() => {
    void loadInitial(workspaceId);
  }, [loadInitial, workspaceId]);

  const isRepo = gitSession?.repoInfo.kind === "repo";
  const branchInfo = isRepo ? (gitSession?.branchInfo ?? null) : null;
  const status = isRepo ? (gitSession?.status ?? null) : null;
  const inFlightOp = gitSession?.inFlightOp ?? null;
  const barRef = useRef<HTMLDivElement>(null);
  const roomForStats = useWiderThan(barRef, STATS_MIN_WIDTH);
  const roomForPorts = useWiderThan(barRef, PORTS_MIN_WIDTH);
  const roomForEditorSegments = useWiderThan(barRef, EDITOR_SEGMENTS_MIN_WIDTH);

  return (
    <div
      ref={barRef}
      className="relative flex shrink-0 h-6 items-center select-none"
      style={{
        color: "var(--status-bar-fg)",
      }}
      role="status"
      aria-label={t("statusBar.aria")}
    >
      <div className="flex items-center flex-1 min-w-0">
        <BranchSegment
          workspaceId={workspaceId}
          branchInfo={branchInfo}
          gitMissing={gitSession?.repoInfo.kind === "git-missing"}
        />

        <ChangesSegment workspaceId={workspaceId} status={status} />

        <DiagnosticSegment kind="error" count={errorCount} workspaceId={workspaceId} />

        <DiagnosticSegment kind="warning" count={warningCount} workspaceId={workspaceId} />
      </div>

      <div className="flex items-center shrink-0 whitespace-nowrap">
        {inFlightOp && <InFlightOpSegment op={inFlightOp} />}
        {roomForStats && <SystemStatsSegment workspaceId={workspaceId} />}
        {roomForPorts && <PortsSegment workspaceId={workspaceId} />}
        {roomForEditorSegments && <EncodingSegment workspaceId={workspaceId} />}
        {roomForEditorSegments && <LspStatusSegment workspaceId={workspaceId} />}
      </div>
    </div>
  );
});

export function BranchSegment({
  workspaceId,
  branchInfo,
  gitMissing = false,
}: {
  workspaceId: string;
  branchInfo: BranchInfo | null;
  gitMissing?: boolean;
}): React.JSX.Element {
  const { t } = useTranslation();
  const [pickerOpen, setPickerOpen] = useState(false);

  if (!branchInfo) return <NoGitSegment gitMissing={gitMissing} />;

  const label = branchLabel(branchInfo, t);

  return (
    <>
      <button
        type="button"
        title={t("statusBar.branch_title", { label })}
        aria-label={t("statusBar.branch_aria", { label })}
        onClick={() => setPickerOpen(true)}
        className={cn(
          "inline-flex min-w-0 items-center gap-1 whitespace-nowrap h-full px-2",
          "text-app-ui-sm font-sans leading-none",
          "hover:bg-[var(--status-bar-item-hover-bg)] focus-visible:bg-[var(--status-bar-item-hover-bg)] focus-visible:outline-none transition-colors",
        )}
      >
        <GitBranch className="size-3 shrink-0" aria-hidden="true" />
        <span className="truncate max-w-40">{label}</span>
      </button>
      <BranchPicker
        workspaceId={workspaceId}
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
      />
    </>
  );
}

function ChangesSegment({
  workspaceId,
  status,
}: {
  workspaceId: string;
  status: GitStatus | null;
}): React.JSX.Element | null {
  const setFilesPanelMode = useUIStore((s) => s.setFilesPanelMode);
  if (!status) return null;
  return (
    <ChangeCountsSegment
      counts={{
        conflict: status.merge.length,
        staged: status.staged.length,
        modified: status.working.length,
        untracked: status.untracked.length,
      }}
      onOpen={() => setFilesPanelMode(workspaceId, "git")}
    />
  );
}

function DiagnosticSegment({
  kind,
  count,
  workspaceId,
}: {
  kind: DiagnosticKind;
  count: number;
  workspaceId: string;
}): React.JSX.Element {
  const { t } = useTranslation();
  const isError = kind === "error";
  const title = isError ? t("statusBar.error", { count }) : t("statusBar.warning", { count });
  const Icon = isError ? XCircle : AlertTriangle;
  const glyphColor = isError ? "var(--status-bar-error-bg)" : "var(--status-bar-warning-bg)";

  const [open, setOpen] = useState(false);
  const disabled = count === 0;

  useEffect(() => {
    if (disabled && open) setOpen(false);
  }, [disabled, open]);

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      label={isError ? t("diagnostics.errors_dialog") : t("diagnostics.warnings_dialog")}
      align="start"
      className="w-[480px] max-w-[min(480px,calc(100vw-2rem))] max-h-[min(360px,60vh)]"
      trigger={
        <button
          type="button"
          title={title}
          disabled={disabled}
          aria-label={title}
          className={cn(
            "inline-flex shrink-0 items-center gap-1 whitespace-nowrap h-full px-2",
            "text-app-ui-sm font-sans leading-none",
            !disabled &&
              "hover:bg-[var(--status-bar-item-hover-bg)] focus-visible:bg-[var(--status-bar-item-hover-bg)] focus-visible:outline-none transition-colors",
            disabled && "text-muted-foreground/70 cursor-default",
          )}
        >
          <Icon
            className="size-3 shrink-0"
            style={{ color: glyphColor, opacity: disabled ? 0.45 : 1 }}
            aria-hidden="true"
          />
          <span style={!disabled ? { color: glyphColor } : undefined}>{count}</span>
        </button>
      }
    >
      <DiagnosticList workspaceId={workspaceId} kind={kind} onClose={() => setOpen(false)} />
    </Popover>
  );
}

function InFlightOpSegment({ op }: { op: GitInFlightOp }): React.JSX.Element {
  const { t } = useTranslation();
  const OP_LABELS: Partial<Record<string, string>> = {
    stage: t("statusBar.op_staging"),
    unstage: t("statusBar.op_unstaging"),
    discard: t("statusBar.op_discarding"),
    commit: t("statusBar.op_committing"),
    fetch: t("statusBar.op_fetching"),
    pull: t("statusBar.op_pulling"),
    push: t("statusBar.op_pushing"),
    pushTags: t("statusBar.op_pushing_tags"),
    sync: t("statusBar.op_syncing"),
    stash: t("statusBar.op_stashing"),
    stashPop: t("statusBar.op_applying_stash"),
    stashApply: t("statusBar.op_applying_stash"),
    stashDrop: t("statusBar.op_dropping_stash"),
    stashGroup: t("statusBar.op_stashing"),
    checkout: t("statusBar.op_checking_out"),
    checkoutDetached: t("statusBar.op_checking_out"),
    checkoutTracking: t("statusBar.op_checking_out"),
    createBranch: t("statusBar.op_creating_branch"),
    deleteBranch: t("statusBar.op_deleting_branch"),
    merge: t("statusBar.op_merging"),
    rebase: t("statusBar.op_rebasing"),
    cherryPick: t("statusBar.op_cherry_picking"),
    abortOp: t("statusBar.op_aborting"),
    continueOp: t("statusBar.op_continuing"),
    refresh: t("statusBar.op_refreshing"),
    init: t("statusBar.op_initializing"),
  };
  const label = OP_LABELS[op.kind] ?? t("statusBar.op_working");
  return (
    <StatusBarItem title={label}>
      <Loader2 className="size-3 shrink-0 animate-spin" aria-hidden="true" />
      <span>{label}</span>
    </StatusBarItem>
  );
}
