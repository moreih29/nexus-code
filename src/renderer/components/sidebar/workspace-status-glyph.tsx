import i18next from "i18next";
import {
  CircleAlert,
  CircleCheck,
  Loader,
  MessageCircleQuestion,
  TriangleAlert,
} from "lucide-react";
import type React from "react";
import { cn } from "@/utils/cn";
import type { ClaudeStatus } from "../../../shared/claude/status";
import { codexStatusLabel, estimatedLabel } from "../agent-list/session-status";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface WorkspaceStatusGlyphProps {
  /** Aggregated Claude session status to display. */
  status: ClaudeStatus;
  /** Status inferred from output (Codex etc.) — "(추정)" is added to the label, also shown on hover. */
  estimated?: boolean;
  /** Status of a Codex tab — the label names Codex, not Claude. */
  codex?: boolean;
}

// ---------------------------------------------------------------------------
// State matrix
// ---------------------------------------------------------------------------

/**
 * Glyph and color mapping per status.
 *
 * A small indicator shown inline on the message line of the sidebar workspace card.
 * Renders only the glyph, with no label or background (minimizes visual noise).
 *
 * | status           | glyph                 | color token                  | note                          |
 * |------------------|-----------------------|------------------------------|-------------------------------|
 * | idle             | (none)                | —                            | glyph itself is not rendered  |
 * | running          | Loader (spin)         | text-emerald-500             | in progress                   |
 * | completed        | CircleCheck           | --tab-claude-attention-fg    | response ended (unseen)       |
 * | needsInput       | MessageCircleQuestion | --tab-claude-attention-fg    | input needed — pulse animation|
 * | permissionPending| CircleAlert           | --state-warning-fg           | permission approval needed    |
 * | error            | TriangleAlert         | --state-error-fg             | error                         |
 *
 * idle draws no glyph to reduce visual noise. Green for running and blue for completed
 * were specified directly. needsInput has the same color as completed but is told apart by the pulse.
 */

interface GlyphConfig {
  ariaLabel: string;
  /** Glyph color as Tailwind classes */
  colorClass: string;
  Icon: React.ComponentType<{
    width?: number;
    height?: number;
    strokeWidth?: number;
    "aria-hidden"?: boolean;
    className?: string;
  }>;
  spin?: boolean;
  /** Whether to apply a pulse animation to draw attention */
  pulse?: boolean;
}

function getGlyphConfig(status: Exclude<ClaudeStatus, "idle">): GlyphConfig {
  switch (status) {
    case "running":
      return {
        ariaLabel: i18next.t("common:claudeStatus.running"),
        colorClass: "text-emerald-500",
        Icon: Loader,
        spin: true,
      };
    case "completed":
      return {
        ariaLabel: i18next.t("common:claudeStatus.completed"),
        colorClass: "text-(--tab-claude-attention-fg)",
        Icon: CircleCheck,
      };
    case "needsInput":
      return {
        ariaLabel: i18next.t("common:claudeStatus.needsInput"),
        colorClass: "text-(--tab-claude-attention-fg)",
        Icon: MessageCircleQuestion,
        pulse: true,
      };
    case "permissionPending":
      return {
        ariaLabel: i18next.t("common:claudeStatus.permissionPending"),
        colorClass: "text-(--state-warning-fg)",
        Icon: CircleAlert,
      };
    case "error":
      return {
        ariaLabel: i18next.t("common:claudeStatus.error"),
        colorClass: "text-(--state-error-fg)",
        Icon: TriangleAlert,
      };
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Small status glyph for a workspace card.
 *
 * Renders as a 12px glyph inline on the message line. The idle status draws no glyph at all
 * (returns null). With no background, padding or label, it conveys the status by color and shape only.
 */
export function WorkspaceStatusGlyph({
  status,
  estimated = false,
  codex = false,
}: WorkspaceStatusGlyphProps) {
  if (status === "idle") return null;
  const config = getGlyphConfig(status);
  const { colorClass, Icon, spin, pulse } = config;
  const ariaLabel = estimated
    ? estimatedLabel(status)
    : codex
      ? codexStatusLabel(status)
      : config.ariaLabel;

  return (
    <span
      role="status"
      aria-label={ariaLabel}
      title={estimated ? ariaLabel : undefined}
      className={cn("inline-flex shrink-0", colorClass, pulse && "motion-safe:animate-pulse")}
    >
      <Icon
        width={12}
        height={12}
        strokeWidth={1.5}
        aria-hidden
        className={cn("shrink-0", spin && "motion-safe:animate-spin")}
      />
    </span>
  );
}
