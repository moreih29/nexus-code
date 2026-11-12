// Agent list — the agents a conversation runs, listed under its row: a line
// each, set in from the row and joined to it, so which conversation an agent
// belongs to reads in the list as in a tree. Those still running show, and
// the one selected.

import { Bot, CornerDownRight } from "lucide-react";
import { cn } from "@/utils/cn";
import type { AgentRun } from "../../../shared/claude/activity";
import { rowAgents } from "../../services/agent-sessions/agents";
import { ClaudeIcon, CodexIcon } from "../chat/agent-icons";
import { AgentDuration, AgentGlyph, agentLabel, agentStateLabel } from "./agent-status";

export function AgentRows({
  agents,
  selectedId,
  onSelect,
  className,
}: {
  agents: readonly AgentRun[];
  /** The agent selected, when one of these is. */
  selectedId: string | undefined;
  /** Picked, with its row: the agent list opens its card beside it. */
  onSelect: (agentId: string, from: HTMLElement) => void;
  className?: string;
}) {
  const shown = rowAgents(agents, selectedId);
  if (shown.length === 0) return null;
  return (
    <ul className={cn("flex min-w-0 flex-col", className)} data-testid="agent-list-agent-rows">
      {shown.map((agent) => {
        const selected = agent.id === selectedId;
        return (
          <li key={agent.id} className="min-w-0">
            <button
              type="button"
              aria-pressed={selected}
              onClick={(event) => onSelect(agent.id, event.currentTarget)}
              title={`${agentLabel(agent)} · ${agentStateLabel(agent.state)}`}
              className={cn(
                "flex w-full min-w-0 items-center gap-1.5 rounded-(--radius-control) py-0.5 pr-1 text-left text-app-micro transition-colors outline-none focus-visible:ring-1 focus-visible:ring-ring",
                selected
                  ? "bg-[var(--sidebar-item-selected-bg)] text-foreground"
                  : "text-muted-foreground hover:bg-[var(--state-hover-bg)] hover:text-foreground",
              )}
            >
              <CornerDownRight aria-hidden className="size-3 shrink-0 text-muted-foreground/70" />
              <AgentGlyph state={agent.state} />
              <AgentKindMark agent={agent} />
              <span className="min-w-0 flex-1 truncate">{agentLabel(agent)}</span>
              <AgentDuration agent={agent} />
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** A subagent's mark, or the program a run runs. */
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
