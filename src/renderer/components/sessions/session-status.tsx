// Sessions tab — a session's state as a glyph and words, its agent as a
// badge, and how long it has been in that state.
//
// The glyphs and colors are the sidebar's (workspace-status-glyph.tsx), so
// a state reads the same everywhere. States told from output rather than
// reported by hooks (Codex and other agents) say so: "(estimated)".

import i18next from "i18next";
import {
  Circle,
  CircleAlert,
  CircleCheck,
  CircleX,
  Loader,
  type LucideIcon,
  MessageCircleQuestion,
  TriangleAlert,
} from "lucide-react";
import { cn } from "@/utils/cn";
import type { AgentSession } from "../../services/sessions/model";

interface StateLook {
  Icon: LucideIcon;
  colorClass: string;
  spin?: boolean;
}

function lookOf(state: string): StateLook {
  switch (state) {
    case "permissionPending":
      return { Icon: CircleAlert, colorClass: "text-(--state-warning-fg)" };
    case "needsInput":
      return { Icon: MessageCircleQuestion, colorClass: "text-(--tab-claude-attention-fg)" };
    case "error":
      return { Icon: TriangleAlert, colorClass: "text-(--state-error-fg)" };
    case "running":
    case "busy":
      return { Icon: Loader, colorClass: "text-emerald-500", spin: true };
    case "completed":
      return { Icon: CircleCheck, colorClass: "text-(--tab-claude-attention-fg)" };
    case "exited":
      return { Icon: CircleX, colorClass: "text-muted-foreground" };
    default:
      return { Icon: Circle, colorClass: "text-muted-foreground" };
  }
}

/** The state in words, e.g. "Waiting for permission" or "Running (estimated)". */
export function stateLabel(session: Pick<AgentSession, "state" | "estimated">): string {
  const label = i18next.t(`common:sessions.state.${session.state}`, {
    defaultValue: session.state,
  });
  return session.estimated && session.state !== "exited"
    ? i18next.t("common:sessions.estimated", { label })
    : label;
}

/** How long ago `since` was: "just now", "12m", "3h", "2d". */
export function durationLabel(since: number | undefined, now: number): string | null {
  if (since === undefined) return null;
  const minutes = Math.floor(Math.max(0, now - since) / 60_000);
  if (minutes < 1) return i18next.t("common:sessions.duration.now");
  if (minutes < 60) return i18next.t("common:sessions.duration.minutes", { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return i18next.t("common:sessions.duration.hours", { count: hours });
  return i18next.t("common:sessions.duration.days", { count: Math.floor(hours / 24) });
}

export function StateGlyph({ state, className }: { state: string; className?: string }) {
  const { Icon, colorClass, spin } = lookOf(state);
  return (
    <Icon
      aria-hidden
      width={12}
      height={12}
      strokeWidth={1.5}
      className={cn("shrink-0", colorClass, spin && "motion-safe:animate-spin", className)}
    />
  );
}

/** Glyph, state and how long it has lasted, e.g. "◌ Running · 12m". */
export function SessionState({
  session,
  now,
  className,
}: {
  session: AgentSession;
  now: number;
  className?: string;
}) {
  const duration = durationLabel(session.since, now);
  const { colorClass } = lookOf(session.state);
  return (
    <span className={cn("inline-flex items-center gap-1.5 min-w-0 text-app-ui-sm", className)}>
      <StateGlyph state={session.state} />
      <span
        className={cn("truncate", session.phase === "idle" ? "text-muted-foreground" : colorClass)}
      >
        {stateLabel(session)}
      </span>
      {duration && <span className="shrink-0 text-muted-foreground">· {duration}</span>}
    </span>
  );
}

/** The agent's name in a small monospace badge. */
export function AgentBadge({ agent }: { agent: string | undefined }) {
  return (
    <span className="shrink-0 rounded-(--radius-control) bg-muted px-1.5 font-mono text-app-micro text-muted-foreground">
      {agent ?? i18next.t("common:sessions.agent_unknown")}
    </span>
  );
}
