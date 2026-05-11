/**
 * OperationBanner owns the Source Control continue/abort affordance for
 * in-progress merge, rebase, and cherry-pick workflows.
 */
import { CircleAlert, GitMerge, Loader2 } from "lucide-react";
import type { GitOperationState } from "../../../../shared/types/git";
import type { GitStoreError } from "../../../state/stores/git";
import { cn } from "../../../utils/cn";
import { Button } from "../../ui/button";

export type ActiveGitOperationState = Exclude<GitOperationState, { kind: "none" }>;
export type OperationBannerInFlightKind = "continueOp" | "abortOp" | string;

export interface OperationBannerView {
  variant: "info" | "error";
  role: "status" | "alert";
  message: string;
  details?: string;
  continueLabel: string;
  abortLabel: string;
  continueTooltip?: string;
  continueAriaDisabled: boolean;
}

type OperationBannerBaseView = Omit<OperationBannerView, "message" | "details">;

interface OperationBannerProps {
  state: ActiveGitOperationState;
  error?: GitStoreError | null;
  inFlightKind?: OperationBannerInFlightKind | null;
  onContinue: () => void;
  onAbort: () => void;
}

/** Builds the banner message/action model for tests and rendering. */
export function buildOperationBannerView(
  state: ActiveGitOperationState,
  error?: GitStoreError | null,
): OperationBannerView {
  const conflictCount = state.conflictCount;
  const continueTooltip =
    conflictCount > 0
      ? `Resolve ${conflictCount} conflict${conflictCount === 1 ? "" : "s"} first.`
      : undefined;

  if (error && isWorkflowError(error.operation)) {
    return {
      variant: "error",
      role: "alert",
      message: error.message,
      details: error.details,
      continueLabel: "Retry",
      abortLabel: "Abort",
      continueTooltip,
      continueAriaDisabled: conflictCount > 0,
    };
  }

  const base = {
    variant: "info" as const,
    role: "status" as const,
    continueLabel: "Continue",
    abortLabel: "Abort",
    continueTooltip,
    continueAriaDisabled: conflictCount > 0,
  };

  switch (state.kind) {
    case "merge":
      if (conflictCount > 0) {
        return {
          ...base,
          message: `Merging ${formatRef(state.mergeLabel ?? state.mergeRef, "selected branch")} into ${formatRef(
            state.headRef,
            "current branch",
          )} — ${formatConflictsRemain(conflictCount)}`,
          details: "Resolve files below, then Continue.",
        };
      }
      return readyView("Merge", base);
    case "rebase":
      return rebaseBannerView(state, base);
    case "cherry-pick":
      if (conflictCount > 0) {
        return {
          ...base,
          message: `Cherry-picking ${shortSha(state.sourceSha)} — ${formatConflictsRemain(
            conflictCount,
          )}`,
          details: state.sourceSubject ?? "Resolve files below, then Continue.",
        };
      }
      return readyView("Cherry-pick", base);
    case "revert":
      if (conflictCount > 0) {
        return {
          ...base,
          message: `Reverting ${shortSha(state.sourceSha)} — ${formatConflictsRemain(
            conflictCount,
          )}`,
          details: state.sourceSubject ?? "Resolve files below, then Continue.",
        };
      }
      return readyView("Revert", base);
  }
}

/** Renders the operation banner and its single continue/abort action pair. */
export function OperationBanner({
  state,
  error,
  inFlightKind,
  onContinue,
  onAbort,
}: OperationBannerProps): React.JSX.Element {
  const view = buildOperationBannerView(state, error);
  const continuing = inFlightKind === "continueOp";
  const aborting = inFlightKind === "abortOp";
  const actionsBusy = continuing || aborting;
  const Icon = view.variant === "error" ? CircleAlert : GitMerge;

  function runContinue(): void {
    if (view.continueAriaDisabled || actionsBusy) return;
    onContinue();
  }

  function runAbort(): void {
    if (actionsBusy) return;
    onAbort();
  }

  return (
    <div
      className={cn(
        "mx-2 my-1 rounded-md border px-2 py-2 text-app-ui-sm",
        view.variant === "error"
          ? "border-destructive/60 bg-destructive/10 git-destructive-text"
          : "border-mist-border bg-frosted-veil text-foreground",
      )}
      role={view.role}
      aria-live={view.role === "alert" ? "assertive" : "polite"}
    >
      <div className="flex items-start gap-2">
        <Icon className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="break-words text-foreground">{view.message}</p>
          {view.details ? (
            <p className="mt-0.5 break-words text-muted-foreground">{view.details}</p>
          ) : null}
        </div>
      </div>
      <div className="mt-2 flex gap-2 pl-5">
        <Button
          type="button"
          size="sm"
          className="h-7 px-2 text-app-ui-sm"
          aria-disabled={view.continueAriaDisabled || actionsBusy}
          title={view.continueTooltip}
          onClick={runContinue}
        >
          {continuing ? <Loader2 className="size-3.5 animate-spin" aria-hidden="true" /> : null}
          {continuing ? "Continuing…" : view.continueLabel}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-app-ui-sm git-destructive-text"
          aria-disabled={actionsBusy}
          onClick={runAbort}
        >
          {aborting ? <Loader2 className="size-3.5 animate-spin" aria-hidden="true" /> : null}
          {aborting ? "Aborting…" : view.abortLabel}
        </Button>
      </div>
    </div>
  );
}

/**
 * Builds the rebase message without ever inventing `step ?/?` when Git did
 * not provide usable progress counters.
 */
function rebaseBannerView(
  state: Extract<ActiveGitOperationState, { kind: "rebase" }>,
  base: OperationBannerBaseView,
): OperationBannerView {
  const step = formatRebaseStep(state);
  const onto = formatRef(state.ontoLabel ?? state.ontoRef, "target");
  if (state.conflictCount > 0) {
    const progress = step ? ` — ${step}` : "";
    return {
      ...base,
      message: `Rebasing onto ${onto}${progress} · ${formatConflictsRemain(state.conflictCount)}`,
      details: state.currentCommitSubject ?? "Resolve files below, then Continue.",
    };
  }

  return {
    ...base,
    message: step ? `Rebase paused at ${step}` : `Rebasing onto ${onto}`,
    details: "Resolve, then Continue.",
  };
}

/** Builds the shared clean workflow ready copy. */
function readyView(verb: string, base: OperationBannerBaseView): OperationBannerView {
  return { ...base, message: `${verb} ready to continue`, details: "All conflicts resolved." };
}

/** Formats rebase progress only when both counters are known. */
function formatRebaseStep(
  state: Extract<ActiveGitOperationState, { kind: "rebase" }>,
): string | null {
  if (state.doneCount <= 0 || state.totalCount <= 0) return null;
  return `step ${state.doneCount} of ${state.totalCount}`;
}

/** Formats an optional ref with a human fallback. */
function formatRef(ref: string | null, fallback: string): string {
  return ref && ref.trim().length > 0 ? ref : fallback;
}

/** Formats conflict count text while preserving the task copy. */
function formatConflictCount(count: number): string {
  return `${count} conflict${count === 1 ? "" : "s"}`;
}

/** Formats the full "N conflicts remain" phrase. */
function formatConflictsRemain(count: number): string {
  return `${formatConflictCount(count)} ${count === 1 ? "remains" : "remain"}`;
}

/** Returns a short SHA-like display value with a fallback. */
function shortSha(sha: string | null): string {
  return sha && sha.length > 0 ? sha.slice(0, 7) : "commit";
}

/** Limits failed-operation chrome to the workflow calls this banner owns. */
function isWorkflowError(operation: string | undefined): boolean {
  return (
    operation === "merge" ||
    operation === "rebase" ||
    operation === "cherryPick" ||
    operation === "continueOp" ||
    operation === "abortOp" ||
    operation === "markResolved"
  );
}
