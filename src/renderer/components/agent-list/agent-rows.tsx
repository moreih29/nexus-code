import { Bot, CornerDownRight } from "lucide-react";
import { cn } from "@/utils/cn";
import type { AgentRun } from "../../../shared/claude/activity";
import { rowAgents } from "../../services/agent-sessions/agents";
import { ClaudeIcon, CodexIcon } from "../chat/agent-icons";
import { tooltipProps } from "../ui/tooltip";
import { AgentDuration, AgentGlyph, agentLabel, agentStateLabel } from "./agent-status";

const ROW =
  "flex w-full min-w-0 items-center gap-1.5 rounded-(--radius-control) py-0.5 pr-1 text-left text-app-micro";

export function AgentRows({
  agents,
  selectedId,
  onSelect,
  className,
}: {
  agents: readonly AgentRun[];
  selectedId: string | undefined;
  onSelect?: (agentId: string, from: HTMLElement) => void;
  className?: string;
}) {
  const shown = rowAgents(agents, selectedId);
  if (shown.length === 0) return null;
  return (
    <ul className={cn("flex min-w-0 flex-col", className)} data-testid="agent-list-agent-rows">
      {shown.map((agent) => {
        const selected = agent.id === selectedId;
        const title = `${agentLabel(agent)} · ${agentStateLabel(agent.state)}`;
        const line = (
          <>
            <CornerDownRight aria-hidden className="size-3 shrink-0 text-muted-foreground/70" />
            <AgentGlyph state={agent.state} />
            <AgentKindMark agent={agent} />
            <span className="min-w-0 flex-1 truncate">{agentLabel(agent)}</span>
            <AgentDuration agent={agent} />
          </>
        );
        return (
          <li key={agent.id} className="min-w-0">
            {onSelect ? (
              <button
                type="button"
                aria-pressed={selected}
                onClick={(event) => onSelect(agent.id, event.currentTarget)}
                {...tooltipProps(title)}
                className={cn(
                  ROW,
                  "transition-colors outline-none focus-visible:ring-1 focus-visible:ring-ring",
                  selected
                    ? "bg-[var(--sidebar-item-selected-bg)] text-foreground"
                    : "text-muted-foreground hover:bg-[var(--state-hover-bg)] hover:text-foreground",
                )}
              >
                {line}
              </button>
            ) : (
              <div {...tooltipProps(title)} className={cn(ROW, "text-muted-foreground")}>
                {line}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function AgentKindMark({ agent }: { agent: AgentRun }) {
  const cls = "size-3 shrink-0";
  if (agent.kind === "subagent") {
    return <Bot aria-hidden className={cn(cls, "text-muted-foreground")} />;
  }
  return agent.program === "codex" ? (
    <CodexIcon aria-hidden className={cls} />
  ) : (
    <ClaudeIcon aria-hidden className={cls} />
  );
}
