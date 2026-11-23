import { ChevronRight, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/utils/cn";
import type { AgentRun, PermissionAsk } from "../../../shared/claude/activity";
import { showTerminal } from "../../services/agent-sessions/actions";
import type { AgentSession, WorktreeEntry } from "../../services/agent-sessions/model";
import { useRunConversation } from "../../services/chat/print-run-transcript";
import { stopPrintRun } from "../../services/chat/print-runs";
import { useSubagentConversation } from "../../services/chat/subagent-conversation";
import { askToShowAgent } from "../../state/stores/agent-reveal";
import { RunBody, type RunConversation } from "../chat/print-run-pane";
import { RunHeader, RunOpenButton, RunStopButton } from "../chat/run-header";
import { Button } from "../ui/button";
import { tooltipProps } from "../ui/tooltip";
import { agentTitle } from "./agent-status";
import { PermissionAsks } from "./permission-asks";
import { useTabProfileId } from "./session-profile";
import { AgentMark } from "./status-view";

export function AgentDetail({
  worktree,
  session,
  sessionId,
  agent,
  asks,
  visible,
  onShowSession,
  onClose,
}: {
  worktree: WorktreeEntry;
  session: AgentSession;
  sessionId: string | undefined;
  agent: AgentRun;
  asks: readonly PermissionAsk[];
  visible: boolean;
  onShowSession: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const conversation = useAgentConversation(session, sessionId, agent, visible);
  const openLabel =
    session.kind === "claude"
      ? t("agentList.detail.show_claude_tab")
      : session.kind === "codex"
        ? t("agentList.detail.show_codex_tab")
        : t("agentList.detail.show_terminal");
  const rootPath = worktree.workspace.rootPath;
  const crumb =
    agent.kind === "print"
      ? t(agent.program === "codex" ? "chat.run.kind_codex" : "chat.run.kind")
      : t("agentList.agents.agent_crumb");
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      <div className="flex shrink-0 flex-col gap-4 p-4 pb-2">
        <nav
          aria-label={crumb}
          className="flex min-w-0 items-center gap-1 text-app-micro text-muted-foreground"
        >
          <span className="max-w-40 shrink-0 truncate">{worktree.workspace.name}</span>
          <ChevronRight aria-hidden className="size-3 shrink-0" />
          <Crumb
            tooltip={t("agentList.agents.parent", { title: session.title })}
            onClick={onShowSession}
          >
            <AgentMark session={session} className="size-3" />
            <span className="truncate">{session.title}</span>
          </Crumb>
          <ChevronRight aria-hidden className="size-3 shrink-0" />
          <span className="shrink-0">{crumb}</span>
          <Button
            size="icon-sm"
            variant="ghost"
            className="-my-1 ml-auto size-6 shrink-0"
            tooltip={t("agentList.agents.close_card")}
            onClick={onClose}
          >
            <X aria-hidden className="size-3.5" />
          </Button>
        </nav>
        <RunHeader
          run={agent}
          title={agentTitle(agent)}
          actions={
            <>
              <RunOpenButton
                label={openLabel}
                onClick={() => {
                  if (session.kind !== "terminal") askToShowAgent(session.tabId, agent);
                  showTerminal(session);
                  onClose();
                }}
              />
              {agent.kind === "print" && agent.end === undefined && (
                <RunStopButton
                  onClick={() => void stopPrintRun(session.workspaceId, session.tabId, agent.id)}
                />
              )}
            </>
          }
        />
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
      </div>
      <RunBody
        workspaceId={worktree.workspace.id}
        cwd={rootPath}
        rootPath={rootPath}
        run={agent}
        visible={visible}
        conversation={conversation}
        summary
      />
    </div>
  );
}

function useAgentConversation(
  session: AgentSession,
  sessionId: string | undefined,
  agent: AgentRun,
  visible: boolean,
): RunConversation | null {
  const profileId = useTabProfileId(session);
  const print = agent.kind === "print";
  const run = useRunConversation(session.workspaceId, session.tabId, agent, visible && print);
  const subagent = useSubagentConversation(
    session.workspaceId,
    sessionId,
    profileId,
    agent,
    visible && !print && session.kind !== "codex" && agent.program !== "codex",
  );
  return print ? run : subagent;
}

function Crumb({
  tooltip,
  onClick,
  className,
  children,
}: {
  tooltip: string;
  onClick: () => void;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      {...tooltipProps(tooltip)}
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
