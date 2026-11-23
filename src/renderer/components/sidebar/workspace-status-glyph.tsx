import { cn } from "@/utils/cn";
import type { ClaudeStatus } from "../../../shared/claude/status";
import { estimatedLabel, LookGlyph } from "../agent-list/session-status";
import { programStateLabel, stateLook } from "../agent-list/state-look";

export interface WorkspaceStatusGlyphProps {
  status: ClaudeStatus;
  estimated?: boolean;
  codex?: boolean;
}

export function WorkspaceStatusGlyph({
  status,
  estimated = false,
  codex = false,
}: WorkspaceStatusGlyphProps) {
  if (status === "idle") return null;
  const look = stateLook(status);
  const ariaLabel = estimated
    ? estimatedLabel(status)
    : programStateLabel(codex ? "codex" : "claude", status);

  return (
    <span
      role="status"
      aria-label={ariaLabel}
      title={estimated ? ariaLabel : undefined}
      className={cn("inline-flex shrink-0", look.colorClass)}
    >
      <LookGlyph look={look} />
    </span>
  );
}
