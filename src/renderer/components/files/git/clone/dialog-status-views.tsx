/**
 * Sub-views the Clone dialog renders in its terminal states — clone-in-flight,
 * clone-finished CTAs, and the post-clone action button row.
 *
 * Extracted from `CloneDialog.tsx` to keep that file focused on the form
 * lifecycle (state machine, stream wiring, validation). Everything here is a
 * pure presentational component: state lives in the parent dialog.
 */

import type React from "react";
import type { GitClonePhase } from "../../../../../shared/types/git";
import { Button } from "../../../ui/button";
import { clonePhaseLabel } from "./form-utils";

export type ClonePostCloneAction = "new-window" | "add-workspace" | "current-window";

export interface CloneProgressState {
  readonly phase: GitClonePhase | null;
  readonly pct: number | null;
  readonly cancelling: boolean;
}

export interface CloneSuccessState {
  readonly absPath: string;
  readonly name: string;
}

/** Renders the progress state once the clone stream starts. */
export function CloneProgressContent({
  progress,
  errorMessage,
  onCancelClone,
}: {
  readonly progress: CloneProgressState;
  readonly errorMessage: string | null;
  readonly onCancelClone: () => void;
}): React.JSX.Element {
  const pct = progress.pct ?? 0;
  return (
    <>
      <h2 className="text-app-body-emphasis text-foreground">Cloning repository…</h2>
      <p className="mt-2 text-app-ui-sm text-muted-foreground">
        {progress.cancelling ? "Cancelling and cleaning up…" : clonePhaseLabel(progress.phase)}
      </p>
      <div
        className="mt-4 h-2 overflow-hidden rounded-full bg-frosted-veil"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={progress.pct ?? undefined}
      >
        <div
          className={`h-full rounded-full bg-primary transition-all ${progress.pct === null ? "animate-pulse" : ""}`}
          style={{ width: `${progress.pct === null ? 35 : pct}%` }}
        />
      </div>
      {errorMessage ? (
        <p className="mt-3 text-app-ui-xs git-destructive-text" role="alert">
          {errorMessage}
        </p>
      ) : null}
      <div className="mt-5 flex justify-end">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={progress.cancelling}
          onClick={onCancelClone}
        >
          {progress.cancelling ? "Cancelling…" : "Cancel"}
        </Button>
      </div>
    </>
  );
}

/** Renders the post-clone CTA state. */
export function CloneSuccessContent({
  success,
  errorMessage,
  ctaDefault,
  postCloneBusy,
  currentWindowDirty,
  onPostCloneAction,
}: {
  readonly success: CloneSuccessState;
  readonly errorMessage: string | null;
  readonly ctaDefault: ClonePostCloneAction;
  readonly postCloneBusy: ClonePostCloneAction | null;
  readonly currentWindowDirty: boolean;
  readonly onPostCloneAction: (action: ClonePostCloneAction) => void;
}): React.JSX.Element {
  return (
    <>
      <h2 className="text-app-body-emphasis text-foreground">Clone complete</h2>
      <p className="mt-2 text-app-ui-sm text-muted-foreground">
        Repository cloned to <span className="font-mono text-foreground">{success.absPath}</span>.
      </p>
      {errorMessage ? (
        <p className="mt-3 text-app-ui-xs git-destructive-text" role="alert">
          {errorMessage}
        </p>
      ) : null}
      <div className="mt-5 flex flex-wrap justify-end gap-2">
        <PostCloneButton
          action="new-window"
          label="Open in new window"
          defaultAction={ctaDefault}
          busyAction={postCloneBusy}
          onClick={onPostCloneAction}
        />
        <PostCloneButton
          action="add-workspace"
          label="Add to workspaces"
          defaultAction={ctaDefault}
          busyAction={postCloneBusy}
          onClick={onPostCloneAction}
        />
        <PostCloneButton
          action="current-window"
          label={currentWindowDirty ? "Open in current window ⚠" : "Open in current window"}
          defaultAction={ctaDefault}
          busyAction={postCloneBusy}
          onClick={onPostCloneAction}
          deemphasized
        />
      </div>
    </>
  );
}

/** Renders one Clone success CTA with the session-default emphasis. */
function PostCloneButton({
  action,
  label,
  defaultAction,
  busyAction,
  deemphasized = false,
  onClick,
}: {
  readonly action: ClonePostCloneAction;
  readonly label: string;
  readonly defaultAction: ClonePostCloneAction;
  readonly busyAction: ClonePostCloneAction | null;
  readonly deemphasized?: boolean;
  readonly onClick: (action: ClonePostCloneAction) => void;
}): React.JSX.Element {
  const busy = busyAction !== null;
  const isDefault = action === defaultAction;
  return (
    <Button
      type="button"
      size="sm"
      variant={isDefault && !deemphasized ? "default" : deemphasized ? "ghost" : "outline"}
      disabled={busy}
      onClick={() => onClick(action)}
    >
      {busyAction === action ? "Working…" : label}
    </Button>
  );
}
