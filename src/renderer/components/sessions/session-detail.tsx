// Agents tab — the detail panel: a conversation's (conversation-detail.tsx),
// a terminal agent's (agent-detail.tsx), or a worktree's with no
// conversation chosen: its changes, with the actions on it.

import { ArrowLeft, GitBranch, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { removeTask, showChanges } from "../../services/sessions/actions";
import { type ActivityByKey, findAgent } from "../../services/sessions/agents";
import { allSessions, type SessionFamily, type WorktreeEntry } from "../../services/sessions/model";
import type { WorktreeChanges } from "../../services/sessions/use-family";
import { Button } from "../ui/button";
import { AgentDetail } from "./agent-detail";
import { ConversationDetail } from "./conversation-detail";
import type { SessionsSelection } from "./selection";

const FILES_SHOWN = 50;

interface SessionDetailProps {
  family: SessionFamily;
  selection: SessionsSelection;
  changes: ReadonlyMap<string, WorktreeChanges>;
  activity: ActivityByKey;
  visible: boolean;
  onSelect: (selection: SessionsSelection) => void;
  /** Back to the list, where the panel takes its place. */
  onBack?: () => void;
  /** Closes the panel, where it lies over a view. */
  onClose?: () => void;
}

export function SessionDetail({
  family,
  selection,
  changes,
  activity,
  visible,
  onSelect,
  onBack,
  onClose,
}: SessionDetailProps) {
  const { t } = useTranslation();
  const session =
    selection.kind === "worktree"
      ? undefined
      : allSessions(family).find((s) => s.key === selection.key);
  const workspaceId =
    session?.workspaceId ?? (selection.kind === "worktree" ? selection.workspaceId : "");
  const worktree = family.worktrees.find((w) => w.workspace.id === workspaceId);
  if (!worktree) return null;
  const worktreeChanges = changes.get(worktree.workspace.id);
  const branch = worktree.branch ?? worktreeChanges?.branch;
  const agent =
    session && selection.kind === "agent"
      ? findAgent(activity, session.key, selection.agentId)
      : undefined;
  if (session && !agent) {
    return (
      <ConversationDetail
        session={session}
        branch={branch}
        activity={activity.get(session.key)}
        visible={visible}
        onSelect={onSelect}
        onBack={onBack}
        onClose={onClose}
      />
    );
  }
  return (
    <div className="flex h-full min-h-0 flex-col">
      <PanelBar onBack={onBack} onClose={onClose} />
      <div className="app-scrollbar min-h-0 flex-1 overflow-y-auto">
        {session && agent ? (
          <AgentDetail
            key={`${session.key}:${agent.id}`}
            worktree={worktree}
            session={session}
            agent={agent}
            asks={(activity.get(session.key)?.asks ?? []).filter((ask) => ask.agentId === agent.id)}
            visible={visible}
            onSelect={onSelect}
          />
        ) : (
          <div className="flex min-w-0 flex-col gap-4 p-4">
            <DetailHeader worktree={worktree} branch={branch} />
            <WorktreeActions worktree={worktree} />
            <p className="text-app-ui-sm text-muted-foreground">
              {t("sessions.detail.no_session")}
            </p>
            <ChangedFiles changes={worktreeChanges} />
          </div>
        )}
      </div>
    </div>
  );
}

/** Back to the list, or the panel closed, above a detail with no header of its own for them. */
function PanelBar({ onBack, onClose }: { onBack?: () => void; onClose?: () => void }) {
  const { t } = useTranslation();
  if (!onBack && !onClose) return null;
  return (
    <div
      className={onClose ? "flex shrink-0 px-2 pt-2" : "flex shrink-0 px-2 pt-2 @2xl/agents:hidden"}
    >
      {onBack && (
        <Button
          size="icon-sm"
          variant="ghost"
          className="@2xl/agents:hidden"
          title={t("sessions.detail.back")}
          aria-label={t("sessions.detail.back")}
          onClick={onBack}
        >
          <ArrowLeft aria-hidden className="size-3.5" />
        </Button>
      )}
      {onClose && (
        <Button
          size="icon-sm"
          variant="ghost"
          className="ml-auto"
          title={t("sessions.detail.close")}
          aria-label={t("sessions.detail.close")}
          onClick={onClose}
        >
          <X aria-hidden className="size-3.5" />
        </Button>
      )}
    </div>
  );
}

function DetailHeader({
  worktree,
  branch,
}: {
  worktree: WorktreeEntry;
  branch: string | undefined;
}) {
  const path = worktree.workspace.task?.worktreePath ?? worktree.workspace.rootPath;
  return (
    <header className="flex min-w-0 flex-col gap-1">
      <h2 className="truncate text-app-body-emphasis text-foreground">{worktree.workspace.name}</h2>
      <span className="flex min-w-0 items-center gap-1 font-mono text-app-micro text-muted-foreground">
        {branch && (
          <>
            <GitBranch aria-hidden className="size-3 shrink-0" />
            <span className="shrink-0">{branch}</span>
            <span aria-hidden>·</span>
          </>
        )}
        <span className="truncate" title={path}>
          {path}
        </span>
      </span>
    </header>
  );
}

function WorktreeActions({ worktree }: { worktree: WorktreeEntry }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap gap-2">
      <Button size="sm" variant="outline" onClick={() => showChanges(worktree.workspace.id)}>
        {t("sessions.detail.show_changes")}
      </Button>
      {!worktree.isRoot && (
        <Button
          size="sm"
          variant="outline"
          className="text-(--state-error-fg)"
          onClick={() => removeTask(worktree.workspace.id)}
        >
          {t("sessions.detail.remove_task")}
        </Button>
      )}
    </div>
  );
}

function ChangedFiles({ changes }: { changes: WorktreeChanges | undefined }) {
  const { t } = useTranslation();
  if (!changes) return null;
  const shown = changes.files.slice(0, FILES_SHOWN);
  return (
    <DetailSection title={t("sessions.detail.changes", { count: changes.files.length })}>
      {changes.files.length === 0 ? (
        <p className="text-app-ui-sm text-muted-foreground">{t("sessions.detail.no_changes")}</p>
      ) : (
        <ul className="flex flex-col rounded-(--radius-control) border border-border">
          {shown.map((file) => (
            <li
              key={file.relPath}
              className="flex items-center gap-2 border-b border-border px-2 py-1 last:border-b-0"
            >
              <span className="w-3 shrink-0 font-mono text-app-micro text-muted-foreground">
                {file.code}
              </span>
              <span
                className="truncate font-mono text-app-micro text-foreground"
                title={file.relPath}
              >
                {file.relPath}
              </span>
            </li>
          ))}
          {changes.files.length > shown.length && (
            <li className="px-2 py-1 text-app-micro text-muted-foreground">
              {t("sessions.detail.more_changes", { count: changes.files.length - shown.length })}
            </li>
          )}
        </ul>
      )}
    </DetailSection>
  );
}

function DetailSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="text-app-label uppercase text-muted-foreground">{title}</h3>
      {children}
    </section>
  );
}
