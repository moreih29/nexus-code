import { PanelRightClose, PanelRightOpen } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useNow } from "../../hooks/use-now";
import type { AgentRow, AgentStatus } from "../../services/chat/panel";
import { cn } from "../../utils/cn";
import { elapsedLabel } from "../agent-list/agent-status";
import { IconButton } from "../ui/icon-button";

interface AgentStripProps {
  agents: AgentRow[];
  shown: string | null;
  onShow: (toolUseId: string | null) => void;
  panel?: { open: boolean; onToggle: () => void };
}

export function AgentStrip({ agents, shown, onShow, panel }: AgentStripProps) {
  const { t } = useTranslation();
  const [showFinished, setShowFinished] = useState(false);
  const running = agents.filter((a) => a.status === "running");
  const finished = agents.filter((a) => a.status !== "running");
  const visible = [...running, ...finished.filter((a) => showFinished || a.toolUseId === shown)];
  if (agents.length === 0 && !panel) return null;
  return (
    <div
      className="flex h-8 shrink-0 items-center gap-1 border-b border-border px-2"
      role="toolbar"
      aria-label={t("chat.strip.aria")}
      data-testid="chat-agent-strip"
    >
      <div className="app-scrollbar flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
        {agents.length > 0 && (
          <StripButton active={shown === null} onClick={() => onShow(null)}>
            {t("chat.strip.main")}
          </StripButton>
        )}
        {visible.map((agent) => (
          <StripButton
            key={agent.toolUseId}
            active={shown === agent.toolUseId}
            onClick={() => onShow(agent.toolUseId)}
            title={agent.description}
          >
            <StatusDot status={agent.status} />
            <span className="max-w-40 truncate">{agent.description}</span>
            {shown === agent.toolUseId && <ShownState agent={agent} />}
          </StripButton>
        ))}
        {finished.length > 0 && (
          <StripButton
            active={false}
            onClick={() => setShowFinished((v) => !v)}
            aria-expanded={showFinished}
          >
            {t("chat.strip.finished", { count: finished.length })}
          </StripButton>
        )}
      </div>
      {panel && (
        <IconButton
          label={panel.open ? t("chat.panel.hide") : t("chat.panel.show")}
          onClick={panel.onToggle}
          aria-pressed={panel.open}
          data-testid="chat-panel-toggle"
        >
          {panel.open ? (
            <PanelRightClose className="size-4" />
          ) : (
            <PanelRightOpen className="size-4" />
          )}
        </IconButton>
      )}
    </div>
  );
}

function StripButton({
  active,
  onClick,
  title,
  children,
  ...rest
}: {
  active: boolean;
  onClick: () => void;
  title?: string;
  children: React.ReactNode;
  "aria-expanded"?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-pressed={active}
      {...rest}
      className={cn(
        "flex shrink-0 items-center gap-1.5 rounded-(--radius-control) px-2 py-0.5 text-app-ui-sm",
        active
          ? "bg-[var(--state-selected-bg)] text-foreground"
          : "text-muted-foreground hover:bg-[var(--state-hover-bg)] hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

export function ShownState({ agent }: { agent: AgentRow }) {
  const { t } = useTranslation();
  const running = agent.status === "running";
  const { startedAt, endedAt } = agent;
  const now = useNow(running && startedAt !== undefined);
  const to = endedAt ?? (running ? now : undefined);
  const took =
    startedAt !== undefined && to !== undefined ? elapsedLabel(Math.max(0, to - startedAt)) : null;
  return (
    <span
      className="shrink-0 text-app-micro text-muted-foreground tabular-nums"
      data-testid="shown-agent-state"
    >
      {[t(`chat.panel.status.${agent.status}`), took].filter(Boolean).join(" · ")}
    </span>
  );
}

export function StatusDot({ status }: { status: AgentStatus | string }) {
  const { t } = useTranslation();
  const known = ["running", "completed", "failed"].includes(status) ? status : "stopped";
  return (
    <span
      role="img"
      aria-label={t(`chat.panel.status.${known}`)}
      title={t(`chat.panel.status.${known}`)}
      className={cn(
        "inline-block size-2 shrink-0 rounded-full",
        known === "running" && "animate-pulse bg-[var(--tab-claude-running-fg)]",
        known === "completed" && "bg-[var(--git-status-added-fg)]",
        known === "failed" && "bg-[var(--state-error-fg)]",
        known === "stopped" && "bg-muted-foreground/50",
      )}
    />
  );
}
