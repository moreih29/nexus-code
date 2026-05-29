/**
 * OperationBanner owns the Source Control continue/abort affordance for
 * in-progress merge, rebase, and cherry-pick workflows.
 *
 * Intentionally not collapsed into the generic Banner primitive: it has a
 * unique two-row layout (message row + continue/abort action row below) and
 * loading-spinner states that Banner's single-row actions[] API cannot express
 * without significant prop proliferation. It does reuse bannerColorClass for
 * color consistency. (T7 consistency review, 2026-05.)
 */
import { CircleAlert, GitMerge, Loader2 } from "lucide-react";
import i18next from "i18next";
import { useTranslation } from "react-i18next";
import type { GitOperationState } from "../../../../../shared/git/types";
import type { GitStoreError } from "../../../../state/stores/git";
import { cn } from "../../../../utils/cn";
import { bannerColorClass } from "../../../ui/banner";
import { Button } from "../../../ui/button";

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
  const t = i18next.t.bind(i18next);
  const conflictCount = state.conflictCount;
  const continueTooltip =
    conflictCount > 0
      ? t("files:git.operations.resolveFirstTooltip", { count: conflictCount })
      : undefined;

  if (error && isWorkflowError(error.operation)) {
    return {
      variant: "error",
      role: "alert",
      message: error.message,
      details: error.details,
      continueLabel: t("files:git.operations.retry"),
      abortLabel: t("files:git.operations.abort"),
      continueTooltip,
      continueAriaDisabled: conflictCount > 0,
    };
  }

  const base = {
    variant: "info" as const,
    role: "status" as const,
    continueLabel: t("files:git.operations.continue"),
    abortLabel: t("files:git.operations.abort"),
    continueTooltip,
    continueAriaDisabled: conflictCount > 0,
  };

  switch (state.kind) {
    case "merge":
      if (conflictCount > 0) {
        return {
          ...base,
          message: t("files:git.operations.merge.conflicts", {
            source: formatRef(state.mergeLabel ?? state.mergeRef, t("files:git.operations.merge.conflicts")),
            target: formatRef(state.headRef, t("files:git.operations.merge.conflicts")),
            conflictText: formatConflictsRemain(conflictCount, t),
          }),
          details: t("files:git.operations.merge.conflictsDetail"),
        };
      }
      return readyView(t("files:git.operations.merge.ready"), t("files:git.operations.merge.readyDetail"), base);
    case "rebase":
      return rebaseBannerView(state, base, t);
    case "cherry-pick":
      if (conflictCount > 0) {
        return {
          ...base,
          message: t("files:git.operations.cherryPick.conflicts", {
            sha: shortSha(state.sourceSha),
            conflictText: formatConflictsRemain(conflictCount, t),
          }),
          details: state.sourceSubject ?? t("files:git.operations.merge.conflictsDetail"),
        };
      }
      return readyView(t("files:git.operations.cherryPick.ready"), t("files:git.operations.merge.readyDetail"), base);
    case "revert":
      if (conflictCount > 0) {
        return {
          ...base,
          message: t("files:git.operations.revert.conflicts", {
            sha: shortSha(state.sourceSha),
            conflictText: formatConflictsRemain(conflictCount, t),
          }),
          details: state.sourceSubject ?? t("files:git.operations.merge.conflictsDetail"),
        };
      }
      return readyView(t("files:git.operations.revert.ready"), t("files:git.operations.merge.readyDetail"), base);
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
        "mx-2 my-1 rounded-(--radius-raised) border px-2 py-2 text-app-ui-sm",
        bannerColorClass(view.variant),
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
          {continuing ? i18next.t("files:git.operations.continuing") : view.continueLabel}
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
          {aborting ? i18next.t("files:git.operations.aborting") : view.abortLabel}
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
  t: (key: string, opts?: Record<string, unknown>) => string,
): OperationBannerView {
  const step = formatRebaseStep(state, t);
  const onto = formatRef(state.ontoLabel ?? state.ontoRef, t("files:git.operations.rebase.rebasing"));
  if (state.conflictCount > 0) {
    const progress = step ? ` — ${step}` : "";
    return {
      ...base,
      message: t("files:git.operations.rebase.conflicts", {
        onto,
        progress,
        conflictText: formatConflictsRemain(state.conflictCount, t),
      }),
      details: state.currentCommitSubject ?? t("files:git.operations.merge.conflictsDetail"),
    };
  }

  return {
    ...base,
    message: step
      ? t("files:git.operations.rebase.paused", { step })
      : t("files:git.operations.rebase.rebasing", { onto }),
    details: t("files:git.operations.rebase.readyDetail"),
  };
}

/** Builds the shared clean workflow ready copy. */
function readyView(message: string, readyDetail: string, base: OperationBannerBaseView): OperationBannerView {
  return { ...base, message, details: readyDetail };
}

/** Formats rebase progress only when both counters are known. */
function formatRebaseStep(
  state: Extract<ActiveGitOperationState, { kind: "rebase" }>,
  t: (key: string, opts?: Record<string, unknown>) => string,
): string | null {
  if (state.doneCount <= 0 || state.totalCount <= 0) return null;
  return t("files:git.operations.rebase.step", { done: state.doneCount, total: state.totalCount });
}

/** Formats an optional ref with a human fallback. */
function formatRef(ref: string | null, fallback: string): string {
  return ref && ref.trim().length > 0 ? ref : fallback;
}

/** Formats the full "N conflicts remain" phrase. */
function formatConflictsRemain(count: number, t: (key: string, opts?: Record<string, unknown>) => string): string {
  return t("files:git.operations.conflictsRemain", { count });
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
