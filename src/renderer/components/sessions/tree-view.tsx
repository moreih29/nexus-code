// Sessions tab — tree view: the workspace and each of its tasks, with the
// agent sessions running in them, one compact row each. Choosing a row
// shows it in the detail panel beside.

import { GitBranch } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/utils/cn";
import type { AgentSession, SessionFamily, WorktreeEntry } from "../../services/sessions/model";
import type { WorktreeChanges } from "../../services/sessions/use-family";
import type { SessionsSelection } from "./selection";
import { AgentBadge, SessionState } from "./session-status";

interface TreeViewProps {
  family: SessionFamily;
  changes: ReadonlyMap<string, WorktreeChanges>;
  selection: SessionsSelection | null;
  onSelect: (selection: SessionsSelection) => void;
  now: number;
}

export function TreeView({ family, changes, selection, onSelect, now }: TreeViewProps) {
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
            <SessionRow
              key={session.key}
              session={session}
              selected={selection?.kind === "session" && selection.key === session.key}
              onSelect={() => onSelect({ kind: "session", key: session.key })}
              now={now}
            />
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
  now,
}: {
  session: AgentSession;
  selected: boolean;
  onSelect: () => void;
  now: number;
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
        <SessionState session={session} now={now} />
      </span>
      <span className="w-full truncate text-app-ui-sm text-muted-foreground">{line}</span>
    </button>
  );
}
