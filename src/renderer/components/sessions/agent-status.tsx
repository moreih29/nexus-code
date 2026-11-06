// Sessions tab — an agent a Claude session runs (a subagent or a `claude -p`
// run): its state as a glyph and words, its name, and what it is doing.
// The glyphs are the sessions' own (session-status.tsx), so a state reads
// the same for a session and its agents.

import i18next from "i18next";
import {
  CircleAlert,
  CircleCheck,
  CircleSlash,
  CircleX,
  Loader,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/utils/cn";
import type { AgentRun, AgentRunState } from "../../../shared/claude/activity";
import { useDurationLabel } from "./session-status";

interface AgentLook {
  Icon: LucideIcon;
  colorClass: string;
  spin?: boolean;
}

function lookOf(state: AgentRunState): AgentLook {
  switch (state) {
    case "running":
      return { Icon: Loader, colorClass: "text-emerald-500", spin: true };
    case "permissionPending":
      return { Icon: CircleAlert, colorClass: "text-(--state-warning-fg)" };
    case "completed":
      return { Icon: CircleCheck, colorClass: "text-(--tab-claude-attention-fg)" };
    case "failed":
      return { Icon: CircleX, colorClass: "text-(--state-error-fg)" };
    default:
      return { Icon: CircleSlash, colorClass: "text-muted-foreground" };
  }
}

export function agentStateColor(state: AgentRunState): string {
  return lookOf(state).colorClass;
}

export function AgentGlyph({ state, className }: { state: AgentRunState; className?: string }) {
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

export function agentStateLabel(state: AgentRunState): string {
  return i18next.t(`common:sessions.agents.state.${state}`);
}

/** What a run started inside a session is called: `claude -p`, or `codex exec`. */
export function printLabel(program: AgentRun["program"]): string {
  return program === "codex"
    ? i18next.t("common:sessions.agents.print_codex")
    : i18next.t("common:sessions.agents.print");
}

/** What the agent was asked to do, else its type. */
export function agentLabel(agent: AgentRun): string {
  return (
    agent.description ??
    agent.type ??
    (agent.kind === "print"
      ? printLabel(agent.program)
      : i18next.t("common:sessions.agents.label_fallback"))
  );
}

/**
 * What the agent is, for a line under its name: its type and whether it runs
 * in the background; for a `claude -p` or `codex exec` run, its model, where
 * it is served when not by its program's own API, and the program.
 */
export function agentKindParts(agent: AgentRun): string[] {
  if (agent.kind === "print") {
    return [agent.model, agent.endpoint, printLabel(agent.program)].filter(
      (part): part is string => part !== undefined,
    );
  }
  return [
    agent.type,
    agent.background ? i18next.t("common:sessions.agents.background") : undefined,
  ].filter((part): part is string => part !== undefined);
}

/** How long `ms` is, to the second under ten minutes: "8s", "1m 52s", "14m", "2h 5m". */
export function elapsedLabel(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1_000));
  if (seconds < 60) return i18next.t("common:sessions.elapsed.seconds", { count: seconds });
  const minutes = Math.floor(seconds / 60);
  if (minutes < 10) {
    return i18next.t("common:sessions.elapsed.minutes_seconds", {
      minutes,
      seconds: seconds % 60,
    });
  }
  if (minutes < 60) return i18next.t("common:sessions.elapsed.minutes", { count: minutes });
  return i18next.t("common:sessions.elapsed.hours_minutes", {
    hours: Math.floor(minutes / 60),
    minutes: minutes % 60,
  });
}

/** How long the agent has run, or ran. */
export function AgentDuration({ agent, className }: { agent: AgentRun; className?: string }) {
  const live = useDurationLabel(agent.end === undefined ? agent.start : undefined);
  const label = agent.end === undefined ? live : elapsedLabel(agent.end - agent.start);
  return label ? (
    <span className={cn("shrink-0 text-app-micro text-muted-foreground", className)}>{label}</span>
  ) : null;
}
