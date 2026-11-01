// Sessions tab — tree view: the workspace and each of its tasks, with the
// agent sessions running in them, one compact row each, and under a Claude
// session the agents it runs. Ended agents fold into one row until opened.
// Choosing a row shows it in the detail panel beside.

import { ChevronRight, GitBranch } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/utils/cn";
import type { AgentRun } from "../../../shared/claude/activity";
import {
  type ActivityByKey,
  agentsOf,
  endedAgents,
  liveAgents,
} from "../../services/sessions/agents";
import type { AgentSession, SessionFamily, WorktreeEntry } from "../../services/sessions/model";
import type { WorktreeChanges } from "../../services/sessions/use-family";
import { AgentLines } from "./agent-status";
import { isAgentSelected, isSessionSelected, type SessionsSelection } from "./selection";
import { AgentBadge, SessionState } from "./session-status";

interface TreeViewProps {
  family: SessionFamily;
  changes: ReadonlyMap<string, WorktreeChanges>;
  activity: ActivityByKey;
  selection: SessionsSelection | null;
  onSelect: (selection: SessionsSelection) => void;
}

export function TreeView({ family, changes, activity, selection, onSelect }: TreeViewProps) {
  return (
    <ul className="flex flex-col gap-1 p-2" aria-label={family.root.name}>
      {family.worktrees.map((worktree) => (
        <li key={worktree.workspace.id} className="flex flex-col gap-0.5">
          <WorktreeRow
            worktree={worktree}
            changes={changes.get(worktree.workspace.id)}
            selected={
              selection?.kind === "worktree" && selection.workspaceId === worktree.workspace.id
            }
            onSelect={() => onSelect({ kind: "worktree", workspaceId: worktree.workspace.id })}
          />
          {worktree.sessions.map((session) => (
            <div key={session.key} className="flex flex-col gap-0.5">
              <SessionRow
                session={session}
                selected={isSessionSelected(selection, session.key)}
                onSelect={() => onSelect({ kind: "session", key: session.key })}
              />
              <AgentRows
                session={session}
                agents={agentsOf(activity, session.key)}
                selection={selection}
                onSelect={onSelect}
              />
            </div>
          ))}
        </li>
      ))}
    </ul>
  );
}

// Selected rows look like the sidebar's and the file tree's: a tinted
// background and a left accent, so state colors stay readable.
export const rowClass = (selected: boolean) =>
  cn(
    "flex w-full min-w-0 rounded-(--radius-control) border-l-2 border-l-transparent px-2 text-left transition-colors",
    selected
      ? "bg-[var(--sidebar-item-selected-bg)] border-l-[var(--state-selected-indicator)] text-[var(--sidebar-item-selected-fg)]"
      : "hover:bg-[var(--state-hover-bg)]",
  );

function WorktreeRow({
  worktree,
  changes,
  selected,
  onSelect,
}: {
  worktree: WorktreeEntry;
  changes: WorktreeChanges | undefined;
  selected: boolean;
  onSelect: () => void;
}) {
  const { t } = useTranslation();
  const branch = worktree.branch ?? changes?.branch;
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={cn(rowClass(selected), "items-center gap-2 py-1.5")}
    >
      <span className="truncate text-app-body-emphasis text-foreground">
        {worktree.workspace.name}
      </span>
      {branch && (
        <span className="flex min-w-0 items-center gap-1 font-mono text-app-micro text-muted-foreground">
          <GitBranch aria-hidden className="size-3 shrink-0" />
          <span className="truncate">{branch}</span>
        </span>
      )}
      <span className="ml-auto shrink-0 text-app-micro text-muted-foreground">
        {worktree.sessions.length === 0
          ? t("sessions.no_sessions")
          : changes && changes.files.length > 0
            ? t("sessions.changed_files", { count: changes.files.length })
            : null}
      </span>
    </button>
  );
}

function SessionRow({
  session,
  selected,
  onSelect,
}: {
  session: AgentSession;
  selected: boolean;
  onSelect: () => void;
}) {
  const line = session.prompt ?? session.message ?? session.title;
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={cn(rowClass(selected), "flex-col gap-0.5 py-1.5 pl-6")}
    >
      <span className="flex w-full min-w-0 items-center gap-2">
        <AgentBadge agent={session.agent} />
        <SessionState session={session} />
      </span>
      <span className="w-full truncate text-app-ui-sm text-muted-foreground">{line}</span>
    </button>
  );
}

/**
 * The agents a session runs, under it on a guide line: the live ones, then
 * the ended ones folded into one row until opened. One that is chosen stays
 * shown.
 */
function AgentRows({
  session,
  agents,
  selection,
  onSelect,
}: {
  session: AgentSession;
  agents: readonly AgentRun[];
  selection: SessionsSelection | null;
  onSelect: (selection: SessionsSelection) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  if (agents.length === 0) return null;
  const live = liveAgents(agents);
  const ended = endedAgents(agents);
  const shownEnded = open
    ? ended
    : ended.filter((agent) => isAgentSelected(selection, session.key, agent.id));
  const row = (agent: AgentRun) => {
    const selected = isAgentSelected(selection, session.key, agent.id);
    return (
      <button
        key={agent.id}
        type="button"
        onClick={() => onSelect({ kind: "agent", key: session.key, agentId: agent.id })}
        aria-pressed={selected}
        className={cn(rowClass(selected), "flex-col gap-0.5 py-1")}
      >
        <AgentLines agent={agent} dim={agent.end !== undefined} />
      </button>
    );
  };
  return (
    <div className="ml-8 flex flex-col gap-0.5 border-l border-border pl-1.5">
      {live.map(row)}
      {ended.length > 0 && (
        <button
          type="button"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          className="flex w-full min-w-0 items-center gap-1 rounded-(--radius-control) px-2 py-1 text-left text-app-micro text-muted-foreground transition-colors hover:bg-[var(--state-hover-bg)]"
        >
          <ChevronRight
            aria-hidden
            className={cn("size-3 shrink-0 transition-transform", open && "rotate-90")}
          />
          {t("sessions.agents.ended_toggle", { count: ended.length })}
        </button>
      )}
      {shownEnded.map(row)}
    </div>
  );
}
