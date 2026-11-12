// Agent list — a session's state as a glyph and words, its agent as a
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
import { useSyncExternalStore } from "react";
import { cn } from "@/utils/cn";
import type { ClaudeStatus } from "../../../shared/claude/status";
import type { AgentSession } from "../../services/agent-sessions/model";

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

/** The color a state's glyph has, for words told beside it. */
export function stateColor(state: string): string {
  return lookOf(state).colorClass;
}

/** The state in words, e.g. "Waiting for permission" or "Running (estimated)". */
export function stateLabel(session: Pick<AgentSession, "state" | "estimated">): string {
  const label = i18next.t(`common:agentList.state.${session.state}`, {
    defaultValue: session.state,
  });
  return session.estimated && session.state !== "exited"
    ? i18next.t("common:agentList.estimated", { label })
    : label;
}

/**
 * The words for a tab or sidebar glyph told from output rather than reported
 * by hooks, e.g. "Running (estimated)".
 */
export function estimatedLabel(status: string): string {
  return stateLabel({ state: status === "running" ? "busy" : status, estimated: true });
}

/** A Codex tab's state in words, as the tab bar and the sidebar name it. */
export function codexStatusLabel(status: ClaudeStatus): string {
  switch (status) {
    case "running":
      return i18next.t("common:codexStatus.running");
    case "completed":
      return i18next.t("common:codexStatus.completed");
    case "needsInput":
      return i18next.t("common:codexStatus.needsInput");
    case "permissionPending":
      return i18next.t("common:codexStatus.permissionPending");
    case "error":
      return i18next.t("common:codexStatus.error");
    case "idle":
      return i18next.t("common:codexStatus.idle");
  }
}

/** How long ago `since` was: "just now", "12m", "3h", "2d". */
export function durationLabel(since: number | undefined, now: number): string | null {
  if (since === undefined) return null;
  const minutes = Math.floor(Math.max(0, now - since) / 60_000);
  if (minutes < 1) return i18next.t("common:agentList.duration.now");
  if (minutes < 60) return i18next.t("common:agentList.duration.minutes", { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return i18next.t("common:agentList.duration.hours", { count: hours });
  return i18next.t("common:agentList.duration.days", { count: Math.floor(hours / 24) });
}

export function StateGlyph({
  state,
  still,
  className,
}: {
  state: string;
  /** Holds the glyph still where it names the state rather than shows one in progress. */
  still?: boolean;
  className?: string;
}) {
  const { Icon, colorClass, spin: spins } = lookOf(state);
  const spin = spins && !still;
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

/**
 * The clock the durations read, one for all of them: it ticks while any is
 * shown, often enough for the minutes they count.
 */
const CLOCK_TICK_MS = 10_000;
const clockListeners = new Set<() => void>();
let clockNow = Date.now();
let clockTimer: ReturnType<typeof setInterval> | undefined;

function subscribeClock(onTick: () => void): () => void {
  clockListeners.add(onTick);
  if (clockTimer === undefined) {
    clockNow = Date.now();
    clockTimer = setInterval(() => {
      clockNow = Date.now();
      for (const listener of clockListeners) listener();
    }, CLOCK_TICK_MS);
  }
  return () => {
    clockListeners.delete(onTick);
    if (clockListeners.size === 0 && clockTimer !== undefined) {
      clearInterval(clockTimer);
      clockTimer = undefined;
    }
  };
}

const readClock = (): number => clockNow;

/**
 * How long ago `since` was, kept current by the shared clock, so a duration
 * re-renders itself rather than the view it is in.
 */
export function useDurationLabel(since: number | undefined): string | null {
  const now = useSyncExternalStore(subscribeClock, readClock, readClock);
  // A state that began after the last tick has lasted no time yet.
  return durationLabel(since, Math.max(now, since ?? 0));
}

/** The agent's name in a small monospace badge. */
export function AgentBadge({ agent }: { agent: string | undefined }) {
  return (
    <span className="shrink-0 rounded-(--radius-control) bg-muted px-1.5 font-mono text-app-micro text-muted-foreground">
      {agent ?? i18next.t("common:agentList.agent_unknown")}
    </span>
  );
}
