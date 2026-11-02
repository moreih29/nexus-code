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
  SquareTerminal,
} from "lucide-react";
import { cn } from "@/utils/cn";
import type { AgentRun, AgentRunState } from "../../../shared/claude/activity";
import { currentTool, toolLine } from "../../services/sessions/agents";
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

/** What the agent was asked to do, else its type. */
export function agentLabel(agent: AgentRun): string {
  return (
    agent.description ??
    agent.type ??
    (agent.kind === "print"
      ? i18next.t("common:sessions.agents.print")
      : i18next.t("common:sessions.agents.label_fallback"))
  );
}

/**
 * What the agent is, for a line under its name: its type and whether it runs
 * in the background; for a `claude -p` run, its model.
 */
export function agentKindParts(agent: AgentRun): string[] {
  if (agent.kind === "print") {
    return [agent.model, i18next.t("common:sessions.agents.print")].filter(
      (part): part is string => part !== undefined,
    );
  }
  return [
    agent.type,
    agent.background ? i18next.t("common:sessions.agents.background") : undefined,
  ].filter((part): part is string => part !== undefined);
}

/** What the agent does now, or did: its tool, its permission wait, its tool count. */
export function agentActivityLine(agent: AgentRun): string {
  const tool = currentTool(agent.tools);
  if (agent.state === "permissionPending") {
    return tool
      ? i18next.t("common:sessions.agents.asking_tool", { tool: toolLine(tool) })
      : agentStateLabel(agent.state);
  }
  if (agent.end === undefined && tool) return toolLine(tool);
  if (agent.kind === "print" && !agent.toolsTold) {
    return agent.exitCode !== undefined && agent.exitCode !== 0
      ? i18next.t("common:sessions.agents.exit_code", { code: agent.exitCode })
      : "";
  }
  return agent.failedCount > 0
    ? i18next.t("common:sessions.agents.tools_failed", {
        count: agent.toolCount,
        failed: agent.failedCount,
      })
    : i18next.t("common:sessions.agents.tools", { count: agent.toolCount });
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

/**
 * An agent as two lines: glyph, name and duration; then what it is and what
 * it does. A `claude -p` run is marked with a terminal glyph.
 */
export function AgentLines({ agent, dim }: { agent: AgentRun; dim?: boolean }) {
  // A permission wait is what matters; else what it is, in a word, and what it does.
  const detail = (
    agent.state === "permissionPending"
      ? [agentActivityLine(agent)]
      : [agentKindParts(agent)[0], agentActivityLine(agent)]
  ).filter((part): part is string => part !== undefined && part !== "");
  return (
    <>
      <span className="flex w-full min-w-0 items-center gap-1.5">
        <AgentGlyph state={agent.state} />
        <span
          className={cn(
            "min-w-0 flex-1 truncate text-app-ui-sm",
            dim ? "text-muted-foreground" : "text-foreground",
          )}
        >
          {agentLabel(agent)}
        </span>
        <AgentDuration agent={agent} />
      </span>
      <span className="flex w-full min-w-0 items-center gap-1 pl-4 font-mono text-app-micro text-muted-foreground">
        {agent.kind === "print" && <SquareTerminal aria-hidden className="size-3 shrink-0" />}
        <span
          className={cn(
            "truncate",
            agent.state === "permissionPending" && "text-(--state-warning-fg)",
          )}
        >
          {detail.join(" · ")}
        </span>
      </span>
    </>
  );
}
