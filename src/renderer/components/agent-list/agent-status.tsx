import i18next from "i18next";
import { cn } from "@/utils/cn";
import type { AgentRun, AgentRunState } from "../../../shared/claude/activity";
import { agentDescription } from "../../services/agent-sessions/agents";
import { LookGlyph, useDurationLabel } from "./session-status";
import { runLook } from "./state-look";

export function agentStateColor(state: AgentRunState): string {
  return runLook(state).colorClass;
}

export function AgentGlyph({ state, className }: { state: AgentRunState; className?: string }) {
  return <LookGlyph look={runLook(state)} className={className} />;
}

export function agentStateLabel(state: AgentRunState): string {
  return i18next.t(runLook(state).labelKey);
}

export function printLabel(program: AgentRun["program"]): string {
  return program === "codex"
    ? i18next.t("common:agentList.agents.print_codex")
    : i18next.t("common:agentList.agents.print");
}

export function agentLabel(agent: AgentRun): string {
  return (
    agentDescription(agent) ??
    agent.type ??
    (agent.kind === "print"
      ? printLabel(agent.program)
      : i18next.t("common:agentList.agents.label_fallback"))
  );
}

export function agentTitle(agent: AgentRun): string {
  return (
    agent.description ??
    agent.type ??
    (agent.kind === "print"
      ? printLabel(agent.program)
      : i18next.t("common:agentList.agents.label_fallback"))
  );
}

export function agentKindParts(agent: AgentRun): string[] {
  if (agent.kind === "print") {
    return [agent.model, agent.endpoint, printLabel(agent.program)].filter(
      (part): part is string => part !== undefined,
    );
  }
  return [
    agent.type,
    agent.background ? i18next.t("common:agentList.agents.background") : undefined,
  ].filter((part): part is string => part !== undefined);
}

export function elapsedLabel(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1_000));
  if (seconds < 60) return i18next.t("common:agentList.elapsed.seconds", { count: seconds });
  const minutes = Math.floor(seconds / 60);
  if (minutes < 10) {
    return i18next.t("common:agentList.elapsed.minutes_seconds", {
      minutes,
      seconds: seconds % 60,
    });
  }
  if (minutes < 60) return i18next.t("common:agentList.elapsed.minutes", { count: minutes });
  return i18next.t("common:agentList.elapsed.hours_minutes", {
    hours: Math.floor(minutes / 60),
    minutes: minutes % 60,
  });
}

export function AgentDuration({ agent, className }: { agent: AgentRun; className?: string }) {
  const live = useDurationLabel(agent.end === undefined ? agent.start : undefined);
  const label = agent.end === undefined ? live : elapsedLabel(agent.end - agent.start);
  return label ? (
    <span className={cn("shrink-0 text-app-micro text-muted-foreground", className)}>{label}</span>
  ) : null;
}
