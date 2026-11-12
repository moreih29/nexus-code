// Agent list — detail panel of an agent a Claude session runs: the
// conversation it belongs to, then what it was asked, wrote and ran, as its
// session's own turn reads (agent-flow.tsx). Its permission requests are
// answered in its terminal or Claude tab.

import { ChevronRight, SquareArrowOutUpRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/utils/cn";
import type { AgentRun, PermissionAsk } from "../../../shared/claude/activity";
import { showTerminal } from "../../services/agent-sessions/actions";
import type { AgentSession, WorktreeEntry } from "../../services/agent-sessions/model";
import { useNow } from "../../services/agent-sessions/use-family";
import { stopPrintRun } from "../../services/chat/print-runs";
import { askToShowAgent } from "../../state/stores/agent-reveal";
import { ChatMarkdown } from "../chat/chat-markdown";
import { RunStopButton } from "../chat/print-run-pane";
import { Button } from "../ui/button";
import { AgentFlow, toolCount } from "./agent-flow";
import {
  AgentDuration,
  AgentGlyph,
  agentKindParts,
  agentStateColor,
  agentStateLabel,
  agentTitle,
} from "./agent-status";
import { PermissionAsks } from "./permission-asks";
import type { AgentListSelection } from "./selection";
import { AgentMark } from "./status-view";

/** How many characters of an agent's id say which one it is. */
const ID_SHOWN = 8;

export function AgentDetail({
  worktree,
  session,
  agent,
  asks,
  visible,
  onSelect,
}: {
  worktree: WorktreeEntry;
  session: AgentSession;
  agent: AgentRun;
  /** The permission requests the agent waits on. */
  asks: readonly PermissionAsk[];
  visible: boolean;
  onSelect: (selection: AgentListSelection) => void;
}) {
  const { t } = useTranslation();
  // Running tools count their seconds.
  const now = useNow(visible && agent.end === undefined);
  const kind = [
    ...agentKindParts(agent),
    ...(agent.kind === "subagent" ? [agent.model, agent.id.slice(0, ID_SHOWN)] : []),
    agent.kind === "subagent" || agent.toolsTold ? toolCount(agent) : undefined,
  ].filter((part): part is string => part !== undefined);
  const openLabel =
    session.kind === "claude"
      ? t("agentList.detail.show_claude_tab")
      : session.kind === "codex"
        ? t("agentList.detail.show_codex_tab")
        : t("agentList.detail.show_terminal");
  return (
    <div className="flex min-w-0 flex-col gap-4 p-4">
      <nav
        aria-label={t("agentList.agents.agent_crumb")}
        className="flex min-w-0 items-center gap-1 text-app-micro text-muted-foreground"
      >
        {/* The workspace keeps its short name; the conversation's title gives way first. */}
        <Crumb
          className="max-w-40 shrink-0"
          onClick={() => onSelect({ kind: "worktree", workspaceId: worktree.workspace.id })}
        >
          <span className="truncate">{worktree.workspace.name}</span>
        </Crumb>
        <ChevronRight aria-hidden className="size-3 shrink-0" />
        {/* The conversation it belongs to, by its mark and title as its row reads. */}
        <Crumb
          title={t("agentList.agents.parent", { title: session.title })}
          onClick={() => onSelect({ kind: "session", key: session.key })}
        >
          <AgentMark session={session} className="size-3" />
          <span className="truncate">{session.title}</span>
        </Crumb>
        <ChevronRight aria-hidden className="size-3 shrink-0" />
        <span className="shrink-0">{t("agentList.agents.agent_crumb")}</span>
      </nav>
      <header className="flex items-start gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <h2 className="break-words text-app-body-emphasis text-foreground">
            {agentTitle(agent)}
          </h2>
          {kind.length > 0 && (
            <span className="truncate font-mono text-app-micro text-muted-foreground">
              {kind.join(" · ")}
            </span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className="inline-flex items-center gap-1.5 text-app-ui-sm">
            <AgentGlyph state={agent.state} />
            <span className={agentStateColor(agent.state)}>{agentStateLabel(agent.state)}</span>
            <AgentDuration agent={agent} className="text-app-ui-sm" />
          </span>
          <Button
            size="icon-sm"
            variant="outline"
            title={openLabel}
            aria-label={openLabel}
            onClick={() => {
              // A chat tab shows the agent in its pane; a terminal has none.
              if (session.kind !== "terminal") askToShowAgent(session.tabId, agent);
              showTerminal(session);
            }}
          >
            <SquareArrowOutUpRight aria-hidden className="size-3.5" />
          </Button>
          {agent.kind === "print" && agent.end === undefined && (
            <RunStopButton
              onClick={() => void stopPrintRun(session.workspaceId, session.tabId, agent.id)}
            />
          )}
        </div>
      </header>
      {asks.length > 0 ? (
        <PermissionAsks session={session} asks={asks} agents={[agent]} />
      ) : (
        agent.state === "permissionPending" && (
          <p className="text-app-ui-sm text-(--state-warning-fg)">
            {t("agentList.agents.detail.permission_hint", {
              context: session.kind === "claude" ? "claude" : undefined,
            })}
          </p>
        )
      )}
      <AgentFlow
        agent={agent}
        now={now}
        renderText={(text) => (
          <ChatMarkdown
            text={text}
            workspaceId={worktree.workspace.id}
            cwd={worktree.workspace.rootPath}
            rootPath={worktree.workspace.rootPath}
          />
        )}
      />
    </div>
  );
}

function Crumb({
  title,
  onClick,
  className,
  children,
}: {
  title?: string;
  onClick: () => void;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={cn(
        "flex min-w-0 max-w-64 shrink items-center gap-1 rounded-(--radius-control) transition-colors hover:text-foreground",
        className,
      )}
    >
      {children}
    </button>
  );
}
