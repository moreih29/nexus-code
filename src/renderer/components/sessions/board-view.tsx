// Sessions tab — board view: a column per phase (waiting on the user,
// running, done, idle) with a card per session. Choosing a card shows it in
// the detail panel beside.

import { GitBranch } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/utils/cn";
import {
  type AgentSession,
  allSessions,
  SESSION_PHASES,
  type SessionFamily,
  type SessionPhase,
} from "../../services/sessions/model";
import type { WorktreeChanges } from "../../services/sessions/use-family";
import type { SessionsSelection } from "./selection";
import { AgentBadge, SessionState } from "./session-status";

interface BoardViewProps {
  family: SessionFamily;
  changes: ReadonlyMap<string, WorktreeChanges>;
  selection: SessionsSelection | null;
  onSelect: (selection: SessionsSelection) => void;
}

export function BoardView({ family, changes, selection, onSelect }: BoardViewProps) {
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
                  selected={selection?.kind === "session" && selection.key === session.key}
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
  selected,
  onSelect,
}: {
  session: AgentSession;
  phase: SessionPhase;
  worktreeName: string;
  branch: string | undefined;
  changedFiles: number | undefined;
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
      {session.prompt && (
        <span className="line-clamp-2 text-app-ui-sm text-foreground">{session.prompt}</span>
      )}
      {session.message && (
        <span className="line-clamp-2 text-app-ui-sm text-muted-foreground">{session.message}</span>
      )}
      {changedFiles !== undefined && changedFiles > 0 && (
        <span className="text-app-micro text-muted-foreground">
          {t("sessions.changed_files", { count: changedFiles })}
        </span>
      )}
    </button>
  );
}
