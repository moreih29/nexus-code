import type { PushGuardActionKind, PushGuardBannerView } from "../utils/push-guard-banner";

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

export type BannerSlotItem = BannerSignal;

export interface GitBannerModel {
  readonly slotItem: BannerSlotItem | null;
  readonly collapsedItems: readonly BannerSlotItem[];
  readonly collapsedCount: number;
}

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

export interface BuildGitBannerModelInput {
  readonly pushGuardBanner: PushGuardBannerView | null;
  readonly onPushGuardAction: (kind: PushGuardActionKind) => void;

  readonly lastError: { message: string; details?: string } | null;
  readonly errorAction: { label: string; onAction: () => void };

  readonly autofetchPaused: boolean;
  readonly autofetchLastErrorMessage: string | undefined;
  readonly onResumeAutofetch: () => void;

  readonly helperPromptOccupancyMessage: string | null;

  readonly contextBanner: { variant: "info" | "error"; message: string } | null;
}

export function buildGitBannerModel(input: BuildGitBannerModelInput): GitBannerModel {
  const signals: BannerSignal[] = [];

  if (input.pushGuardBanner) {
    signals.push({
      kind: "push-guard",
      view: input.pushGuardBanner,
      onAction: input.onPushGuardAction,
    });
  } else if (input.lastError) {
    signals.push({
      kind: "error",
      message: input.lastError.message,
      details: input.lastError.details,
      actionLabel: input.errorAction.label,
      onAction: input.errorAction.onAction,
    });
  }

  if (input.autofetchPaused) {
    signals.push({
      kind: "autofetch-paused",
      details: input.autofetchLastErrorMessage,
      onResume: input.onResumeAutofetch,
    });
  }

  if (input.helperPromptOccupancyMessage) {
    signals.push({
      kind: "helper-prompt",
      message: input.helperPromptOccupancyMessage,
    });
  }

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

  const sorted = [...signals].sort((a, b) => rankOf(b) - rankOf(a));

  const [slotItem, ...collapsedItems] = sorted;
  return {
    slotItem: slotItem ?? null,
    collapsedItems,
    collapsedCount: collapsedItems.length,
  };
}
