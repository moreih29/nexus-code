import { Bot, ListChecks, PanelRightClose, PanelRightOpen, SquareTerminal } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { ChatModel } from "../../services/chat/model";
import { type AgentRow, agentsOf, contextOf, jobsOf, todosOf } from "../../services/chat/panel";
import { ContextRing } from "../ui/context-ring";

export interface SummaryCounts {
  agents: number;
  jobs: number;
  todos: { done: number; total: number } | null;
  contextPercent: number | null;
}

export function summaryCountsOf(model: ChatModel, runs: readonly AgentRow[]): SummaryCounts {
  const todos = todosOf(model.tools);
  const context = contextOf(model.contextUsage);
  return {
    agents: [...agentsOf(model), ...runs].filter((a) => a.status === "running").length,
    jobs: jobsOf(model).filter((j) => j.status === "running").length,
    todos:
      todos.length > 0
        ? { done: todos.filter((todo) => todo.status === "completed").length, total: todos.length }
        : null,
    contextPercent:
      context && context.maxTokens > 0
        ? Math.round((context.totalTokens / context.maxTokens) * 100)
        : null,
  };
}

export function SummaryLine({
  counts,
  open,
  onToggle,
}: {
  counts: SummaryCounts;
  open: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation();
  const facts: { key: string; icon: React.ReactNode; value: string; label: string }[] = [];
  if (counts.agents > 0) {
    facts.push({
      key: "agents",
      icon: <Bot aria-hidden className="size-3 shrink-0" />,
      value: String(counts.agents),
      label: t("chat.strip.summary.agents", { count: counts.agents }),
    });
  }
  if (counts.jobs > 0) {
    facts.push({
      key: "jobs",
      icon: <SquareTerminal aria-hidden className="size-3 shrink-0" />,
      value: String(counts.jobs),
      label: t("chat.strip.summary.jobs", { count: counts.jobs }),
    });
  }
  if (counts.todos) {
    const { done, total } = counts.todos;
    facts.push({
      key: "todos",
      icon: <ListChecks aria-hidden className="size-3 shrink-0" />,
      value: `${done}/${total}`,
      label: t("chat.strip.summary.todos", { done, total }),
    });
  }
  if (counts.contextPercent !== null) {
    const percent = counts.contextPercent;
    facts.push({
      key: "context",
      icon: <ContextRing percent={percent} />,
      value: `${percent}%`,
      label: t("chat.strip.summary.context", { percent }),
    });
  }
  const label = facts.length > 0 ? facts.map((fact) => fact.label).join(" · ") : undefined;
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      aria-label={label}
      title={label}
      className="flex h-7 shrink-0 items-center gap-3 overflow-hidden whitespace-nowrap border-b border-border px-3 text-left text-app-micro text-muted-foreground tabular-nums hover:text-foreground"
      data-testid="chat-summary-line"
    >
      {facts.length > 0 ? (
        facts.map((fact) => (
          <span key={fact.key} className="flex shrink-0 items-center gap-1">
            {fact.icon}
            {fact.value}
          </span>
        ))
      ) : (
        <span className="min-w-0 truncate">{t("chat.panel.show")}</span>
      )}
      {open ? (
        <PanelRightClose aria-hidden className="ml-auto size-3.5 shrink-0" />
      ) : (
        <PanelRightOpen aria-hidden className="ml-auto size-3.5 shrink-0" />
      )}
    </button>
  );
}
