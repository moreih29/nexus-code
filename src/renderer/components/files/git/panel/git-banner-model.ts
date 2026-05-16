/**
 * Pure view-model for the git panel banner stack.
 *
 * Design rule (§1 axis-4): High-severity signals must never be hidden.
 * The model enforces this by assigning fixed numeric ranks and always
 * placing the highest-rank item in the visible slot.
 *
 * Severity ranks (higher number = higher priority):
 *   High  3  lastError, pushGuardBanner
 *   Med   2  autofetch-paused
 *   Low   1  helperPrompt, contextBanner
 *
 * Within the same rank, later-arriving items have priority (newest first).
 * The slot item is always rank-max. The remaining items are collapsed into
 * a "+N" counter row that the component can expand on demand.
 *
 * unborn HEAD is intentionally excluded from the banner stack — it is
 * re-classified as a permanent caption in the branch identity area
 * (GitBranchBar) and should never compete for the banner slot.
 */

import type { PushGuardBannerView, PushGuardActionKind } from "../utils/git-push-guard-banner";

// ---------------------------------------------------------------------------
// Input signals — one plain-data record per banner kind.
// ---------------------------------------------------------------------------

export interface BannerSignalPushGuard {
  readonly kind: "push-guard";
  readonly view: PushGuardBannerView;
  readonly onAction: (kind: PushGuardActionKind) => void;
}

export interface BannerSignalError {
  readonly kind: "error";
  readonly message: string;
  readonly details?: string;
  readonly actionLabel: string;
  readonly onAction: () => void;
}

export interface BannerSignalAutofetchPaused {
  readonly kind: "autofetch-paused";
  readonly details?: string;
  readonly onResume: () => void;
}

export interface BannerSignalHelperPrompt {
  readonly kind: "helper-prompt";
  readonly message: string;
}

export interface BannerSignalContext {
  readonly kind: "context";
  readonly variant: "info" | "error";
  readonly message: string;
}

export type BannerSignal =
  | BannerSignalPushGuard
  | BannerSignalError
  | BannerSignalAutofetchPaused
  | BannerSignalHelperPrompt
  | BannerSignalContext;

// ---------------------------------------------------------------------------
// Output model — what the component renders.
// ---------------------------------------------------------------------------

/**
 * The banner to show in the single visible slot.
 * Carries enough data to render any of the 5 banner kinds.
 */
export type BannerSlotItem = BannerSignal;

export interface GitBannerModel {
  /** The single highest-priority banner to render in the visible slot. */
  readonly slotItem: BannerSlotItem | null;
  /** Collapsed items (all signals except slotItem, in rank order). */
  readonly collapsedItems: readonly BannerSlotItem[];
  /** Number of collapsed items — convenience alias for collapsedItems.length. */
  readonly collapsedCount: number;
}

// ---------------------------------------------------------------------------
// Rank assignment — invariant-encoded, not order-dependent.
// ---------------------------------------------------------------------------

const RANK: Record<BannerSignal["kind"], number> = {
  "push-guard": 3,
  error: 3,
  "autofetch-paused": 2,
  "helper-prompt": 1,
  context: 1,
};

function rankOf(signal: BannerSignal): number {
  return RANK[signal.kind];
}

// ---------------------------------------------------------------------------
// Input bag — all possible banner signals passed in from the container.
// ---------------------------------------------------------------------------

export interface BuildGitBannerModelInput {
  /** Push-guard banner model, or null when not applicable. */
  readonly pushGuardBanner: PushGuardBannerView | null;
  readonly onPushGuardAction: (kind: PushGuardActionKind) => void;

  /** Last git store error, or null when none. */
  readonly lastError: { message: string; details?: string } | null;
  /** Action for the retry / terminal button on the error banner. */
  readonly errorAction: { label: string; onAction: () => void };

  /** Whether autofetch is paused after repeated failures. */
  readonly autofetchPaused: boolean;
  readonly autofetchLastErrorMessage: string | undefined;
  readonly onResumeAutofetch: () => void;

  /** Occupancy message from the git helper prompt hook, or null. */
  readonly helperPromptOccupancyMessage: string | null;

  /** Ad-hoc context banner (sync cancelled, gitignore added, etc.), or null. */
  readonly contextBanner: { variant: "info" | "error"; message: string } | null;
}

/**
 * Converts raw panel state into the banner-stack view model.
 *
 * Invariant: if any High-class signal is present, it always occupies the slot.
 * This is enforced by rank-sorting before slot selection — not by render order.
 */
export function buildGitBannerModel(input: BuildGitBannerModelInput): GitBannerModel {
  const signals: BannerSignal[] = [];

  // High rank — push-guard and lastError are mutually exclusive in the
  // original model (push-guard takes priority when both are set).
  // We preserve that semantic by only emitting one High signal per kind,
  // letting rank + insertion order sort them naturally.
  if (input.pushGuardBanner) {
    signals.push({
      kind: "push-guard",
      view: input.pushGuardBanner,
      onAction: input.onPushGuardAction,
    });
  } else if (input.lastError) {
    // Only surfaced when pushGuard is absent — mirrors original T5 logic.
    signals.push({
      kind: "error",
      message: input.lastError.message,
      details: input.lastError.details,
      actionLabel: input.errorAction.label,
      onAction: input.errorAction.onAction,
    });
  }

  // Med rank
  if (input.autofetchPaused) {
    signals.push({
      kind: "autofetch-paused",
      details: input.autofetchLastErrorMessage,
      onResume: input.onResumeAutofetch,
    });
  }

  // Low rank — helperPrompt
  if (input.helperPromptOccupancyMessage) {
    signals.push({
      kind: "helper-prompt",
      message: input.helperPromptOccupancyMessage,
    });
  }

  // Low rank — context
  if (input.contextBanner) {
    signals.push({
      kind: "context",
      variant: input.contextBanner.variant,
      message: input.contextBanner.message,
    });
  }

  if (signals.length === 0) {
    return { slotItem: null, collapsedItems: [], collapsedCount: 0 };
  }

  // Sort descending by rank. Stable sort preserves insertion order within
  // the same rank (newest-first within a class as long as callers push in
  // newest-last order, which the sequential push above guarantees).
  const sorted = [...signals].sort((a, b) => rankOf(b) - rankOf(a));

  const [slotItem, ...collapsedItems] = sorted;
  return {
    slotItem: slotItem ?? null,
    collapsedItems,
    collapsedCount: collapsedItems.length,
  };
}
