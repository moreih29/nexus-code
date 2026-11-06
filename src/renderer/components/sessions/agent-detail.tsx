// Sessions tab — detail panel of an agent a Claude session runs: where it
// belongs, what it was asked, the tools it ran, and its answer once it is
// done. Its permission requests are answered in its terminal or Claude tab.

import { ChevronRight, SquareArrowOutUpRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { AgentRun, PermissionAsk } from "../../../shared/claude/activity";
import { stopPrintRun } from "../../services/chat/print-runs";
import { showTerminal } from "../../services/sessions/actions";
import type { AgentSession, WorktreeEntry } from "../../services/sessions/model";
import { useNow } from "../../services/sessions/use-family";
import { askToShowAgent } from "../../state/stores/agent-reveal";
import { RunStopButton } from "../chat/print-run-pane";
import { Button } from "../ui/button";
import {
  AgentDuration,
  AgentGlyph,
  agentKindParts,
  agentLabel,
  agentStateColor,
  agentStateLabel,
} from "./agent-status";
import { PermissionAsks } from "./permission-asks";
import type { SessionsSelection } from "./selection";
import { ToolList } from "./tool-list";

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
  onSelect: (selection: SessionsSelection) => void;
}) {
  const { t } = useTranslation();
  // Running tools count their seconds.
  const now = useNow(visible && agent.end === undefined);
  const kind = [
    ...agentKindParts(agent),
    ...(agent.kind === "subagent" ? [agent.model, agent.id.slice(0, ID_SHOWN)] : []),
  ].filter((part): part is string => part !== undefined);
  const told = agent.kind === "subagent" || agent.toolsTold;
  const openLabel =
    session.kind === "claude"
      ? t("sessions.detail.show_claude_tab")
      : session.kind === "codex"
        ? t("sessions.detail.show_codex_tab")
        : t("sessions.detail.show_terminal");
  return (
    <div className="flex min-w-0 flex-col gap-4 p-4">
      <nav
        aria-label={t("sessions.agents.agent_crumb")}
        className="flex min-w-0 flex-wrap items-center gap-1 text-app-micro text-muted-foreground"
      >
        <Crumb onClick={() => onSelect({ kind: "worktree", workspaceId: worktree.workspace.id })}>
          {worktree.workspace.name}
        </Crumb>
        <ChevronRight aria-hidden className="size-3 shrink-0" />
        <Crumb onClick={() => onSelect({ kind: "session", key: session.key })}>
          {t("sessions.agents.session_crumb", {
            agent: session.agent ?? t("sessions.agent_unknown"),
          })}
        </Crumb>
        <ChevronRight aria-hidden className="size-3 shrink-0" />
        <span>{t("sessions.agents.agent_crumb")}</span>
      </nav>
      <header className="flex items-start gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <h2 className="break-words text-app-body-emphasis text-foreground">
            {agentLabel(agent)}
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
            {t("sessions.agents.detail.permission_hint", {
              context: session.kind === "claude" ? "claude" : undefined,
            })}
          </p>
        )
      )}
      {agent.prompt && (
        <Section title={t("sessions.agents.detail.prompt")}>
          <p className="app-scrollbar max-h-48 overflow-y-auto whitespace-pre-wrap break-words text-app-body text-foreground">
            {agent.prompt}
          </p>
        </Section>
      )}
      <Section
        title={t("sessions.agents.detail.activity")}
        aside={
          told
            ? agent.failedCount > 0
              ? t("sessions.agents.tools_failed", {
                  count: agent.toolCount,
                  failed: agent.failedCount,
                })
              : t("sessions.agents.tools", { count: agent.toolCount })
            : undefined
        }
      >
        {!told ? (
          <p className="text-app-ui-sm text-muted-foreground">
            {agent.program === "codex"
              ? t("sessions.agents.detail.tools_untold_codex")
              : t("sessions.agents.detail.tools_untold")}
          </p>
        ) : agent.tools.length === 0 ? (
          <p className="text-app-ui-sm text-muted-foreground">
            {t("sessions.agents.detail.tools_none")}
          </p>
        ) : (
          <ToolList key={agent.id} tools={agent.tools} now={now} />
        )}
      </Section>
      <Section title={t("sessions.agents.detail.answer")}>
        {agent.answer ? (
          <p className="app-scrollbar max-h-80 overflow-y-auto whitespace-pre-wrap break-words text-app-body text-foreground">
            {agent.answer}
          </p>
        ) : (
          <p className="text-app-ui-sm text-muted-foreground">
            {agent.end === undefined
              ? t("sessions.agents.detail.answer_pending")
              : agent.exitCode !== undefined && agent.exitCode !== 0
                ? t("sessions.agents.exit_code", { code: agent.exitCode })
                : t("sessions.agents.detail.answer_none")}
          </p>
        )}
      </Section>
    </div>
  );
}

function Crumb({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="max-w-48 truncate rounded-(--radius-control) transition-colors hover:text-foreground"
    >
      {children}
    </button>
  );
}

function Section({
  title,
  aside,
  children,
}: {
  title: string;
  aside?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="flex items-baseline gap-2 text-app-label uppercase text-muted-foreground">
        {title}
        {aside && <span className="normal-case">{aside}</span>}
      </h3>
      {children}
    </section>
  );
}
