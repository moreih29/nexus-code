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

export interface WorkspaceStatusGlyphProps {
  status: ClaudeStatus;
  estimated?: boolean;
  codex?: boolean;
}

interface GlyphConfig {
  ariaLabel: string;
  colorClass: string;
  Icon: React.ComponentType<{
    width?: number;
    height?: number;
    strokeWidth?: number;
    "aria-hidden"?: boolean;
    className?: string;
  }>;
  spin?: boolean;
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
