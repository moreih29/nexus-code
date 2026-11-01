// Sessions tab — board view: a column per phase (waiting on the user,
// running, done, idle) with a card per session, and in it the agents the
// session runs. Choosing a card shows it in the detail panel beside.

import { GitBranch } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/utils/cn";
import type { AgentRun } from "../../../shared/claude/activity";
import {
  type ActivityByKey,
  agentsOf,
  currentTool,
  endedAgents,
  liveAgents,
  toolLine,
} from "../../services/sessions/agents";
import {
  type AgentSession,
  allSessions,
  SESSION_PHASES,
  type SessionFamily,
  type SessionPhase,
} from "../../services/sessions/model";
import type { WorktreeChanges } from "../../services/sessions/use-family";
import { AgentGlyph, agentKindParts, agentLabel } from "./agent-status";
import { isSessionSelected, type SessionsSelection } from "./selection";
import { AgentBadge, SessionState } from "./session-status";

/** How many agents a card lists; the rest are counted. */
const AGENTS_LISTED = 3;

interface BoardViewProps {
  family: SessionFamily;
  changes: ReadonlyMap<string, WorktreeChanges>;
  activity: ActivityByKey;
  selection: SessionsSelection | null;
  onSelect: (selection: SessionsSelection) => void;
}

export function BoardView({ family, changes, activity, selection, onSelect }: BoardViewProps) {
  const { t } = useTranslation();
  const sessions = allSessions(family);
  const worktreeOf = (session: AgentSession) =>
    family.worktrees.find((w) => w.workspace.id === session.workspaceId);
  return (
    <div className="grid grid-cols-[repeat(auto-fit,minmax(176px,1fr))] items-start gap-2 p-2">
      {SESSION_PHASES.map((phase) => {
        const cards = sessions.filter((s) => s.phase === phase);
        return (
          <section
            key={phase}
            aria-label={t(`sessions.phase.${phase}`)}
            className="flex min-w-0 flex-col gap-2 rounded-(--radius-raised) border border-border bg-muted p-2"
          >
            <header className="flex items-center justify-between px-1">
              <span className="text-app-ui-sm text-foreground">{t(`sessions.phase.${phase}`)}</span>
              <span className="text-app-micro text-muted-foreground">{cards.length}</span>
            </header>
            {cards.length === 0 ? (
              <span className="px-1 pb-1 text-app-micro text-muted-foreground">
                {t("sessions.column_empty")}
              </span>
            ) : (
              cards.map((session) => (
                <SessionCard
                  key={session.key}
                  session={session}
                  phase={phase}
                  worktreeName={worktreeOf(session)?.workspace.name ?? ""}
                  branch={worktreeOf(session)?.branch ?? changes.get(session.workspaceId)?.branch}
                  changedFiles={changes.get(session.workspaceId)?.files.length}
                  agents={agentsOf(activity, session.key)}
                  selected={
                    isSessionSelected(selection, session.key) ||
                    (selection?.kind === "agent" && selection.key === session.key)
                  }
                  onSelect={() => onSelect({ kind: "session", key: session.key })}
                />
              ))
            )}
          </section>
        );
      })}
    </div>
  );
}

function SessionCard({
  session,
  phase,
  worktreeName,
  branch,
  changedFiles,
  agents,
  selected,
  onSelect,
}: {
  session: AgentSession;
  phase: SessionPhase;
  worktreeName: string;
  branch: string | undefined;
  changedFiles: number | undefined;
  agents: readonly AgentRun[];
  selected: boolean;
  onSelect: () => void;
}) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={cn(
        "flex w-full min-w-0 flex-col gap-1.5 rounded-(--radius-control) border bg-background p-2 text-left transition-colors",
        selected
          ? "border-[var(--state-selected-indicator)]"
          : phase === "attention"
            ? "border-(--state-warning-fg) hover:bg-[var(--state-hover-bg)]"
            : "border-border hover:bg-[var(--state-hover-bg)]",
      )}
    >
      <span className="flex w-full min-w-0 items-center gap-2">
        <span className="truncate text-app-body-emphasis text-foreground">{worktreeName}</span>
        <span className="ml-auto">
          <AgentBadge agent={session.agent} />
        </span>
      </span>
      {branch && (
        <span className="flex min-w-0 items-center gap-1 font-mono text-app-micro text-muted-foreground">
          <GitBranch aria-hidden className="size-3 shrink-0" />
          <span className="truncate">{branch}</span>
        </span>
      )}
      <SessionState session={session} />
      <AskingAgent agents={agents} />
      {session.prompt && (
        <span className="line-clamp-2 text-app-ui-sm text-foreground">{session.prompt}</span>
      )}
      {session.message && (
        <span className="line-clamp-2 text-app-ui-sm text-muted-foreground">{session.message}</span>
      )}
      <CardAgents agents={agents} />
      {changedFiles !== undefined && changedFiles > 0 && (
        <span className="text-app-micro text-muted-foreground">
          {t("sessions.changed_files", { count: changedFiles })}
        </span>
      )}
    </button>
  );
}

/** The agent waiting on a permission, boxed as the card's call to the user. */
function AskingAgent({ agents }: { agents: readonly AgentRun[] }) {
  const { t } = useTranslation();
  const asking = agents.find((agent) => agent.state === "permissionPending");
  if (!asking) return null;
  const tool = currentTool(asking.tools);
  return (
    <span className="flex min-w-0 flex-col gap-0.5 rounded-(--radius-control) border border-(--state-warning-fg)/40 bg-(--state-warning-fg)/10 px-2 py-1.5">
      <span className="line-clamp-2 text-app-ui-sm text-(--state-warning-fg)">
        {t("sessions.agents.asking_agent", { name: agentLabel(asking) })}
      </span>
      {tool && (
        <span className="truncate font-mono text-app-micro text-foreground">{toolLine(tool)}</span>
      )}
    </span>
  );
}

/** The session's agents: how many in each state, and the first few by name. */
function CardAgents({ agents }: { agents: readonly AgentRun[] }) {
  const { t } = useTranslation();
  if (agents.length === 0) return null;
  const live = liveAgents(agents);
  const asking = live.filter((agent) => agent.state === "permissionPending").length;
  const ended = endedAgents(agents);
  const counts = [
    live.length - asking > 0 && t("sessions.agents.count_running", { count: live.length - asking }),
    asking > 0 && t("sessions.agents.count_asking", { count: asking }),
    ended.length > 0 && t("sessions.agents.count_ended", { count: ended.length }),
  ].filter((part): part is string => typeof part === "string");
  const listed = [...live, ...ended].slice(0, AGENTS_LISTED);
  return (
    <span className="flex min-w-0 flex-col gap-1 rounded-(--radius-control) border border-border px-2 py-1.5">
      <span className="flex min-w-0 items-center gap-2 text-app-micro text-muted-foreground">
        <span className="shrink-0 text-foreground">
          {t("sessions.agents.summary", { count: agents.length })}
        </span>
        <span className="ml-auto truncate">{counts.join(" · ")}</span>
      </span>
      {listed.map((agent) => (
        // A card is narrow: the agent's name gets the room, its kind the tooltip.
        <span
          key={agent.id}
          title={agentKindParts(agent).join(" · ")}
          className="flex min-w-0 items-center gap-1.5"
        >
          <AgentGlyph state={agent.state} />
          <span
            className={cn(
              "min-w-0 flex-1 truncate text-app-ui-sm",
              agent.end === undefined ? "text-foreground" : "text-muted-foreground",
            )}
          >
            {agentLabel(agent)}
          </span>
        </span>
      ))}
      {agents.length > listed.length && (
        <span className="text-app-micro text-muted-foreground">
          {t("sessions.agents.more", { count: agents.length - listed.length })}
        </span>
      )}
    </span>
  );
}
