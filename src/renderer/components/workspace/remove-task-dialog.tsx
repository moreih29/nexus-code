import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { MOUNT_CLICK_GRACE_MS } from "@/components/ui/confirm-dialog";
import { Dialog } from "@/components/ui/dialog";
import { DialogHeader } from "@/components/ui/dialog-header";
import type { SessionFamily } from "../../services/agent-sessions/model";
import { listed } from "../../services/agent-sessions/rows";
import { sessionsInputNow } from "../../services/agent-sessions/use-inbox";
import { buildAgents } from "../../services/agent-view/agents";
import { countUnsavedBuffers } from "../../services/editor/save/unsaved-guard";
import { removeTask } from "../../services/workspace/tasks";
import { useTabActivityStore } from "../../state/stores/tab-activity";
import { useTaskUIStore } from "../../state/stores/task-ui";
import { useWorkspacesStore } from "../../state/stores/workspaces";

export function RemoveTaskDialogRoot(): React.JSX.Element {
  const { t } = useTranslation();
  const taskId = useTaskUIStore((s) => s.removeTaskId);
  const close = useTaskUIStore((s) => s.closeRemoveTask);
  const task = useWorkspacesStore((s) =>
    taskId === null ? undefined : s.workspaces.find((w) => w.id === taskId && w.task),
  );

  const [deleteBranch, setDeleteBranch] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unsavedCount, setUnsavedCount] = useState(0);
  const [closing, setClosing] = useState<readonly ClosingConversation[]>([]);
  const mountAtRef = useRef(0);
  const branchId = useId();

  useEffect(() => {
    if (taskId === null) return;
    setDeleteBranch(false);
    setDirty(false);
    setBusy(false);
    setError(null);
    setUnsavedCount(countUnsavedBuffers(taskId));
    setClosing(
      closingConversations(
        buildAgents(sessionsInputNow(useTabActivityStore.getState().activity)).families,
        taskId,
      ),
    );
    mountAtRef.current = performance.now();
  }, [taskId]);

  function cancel(): void {
    if (!busy) close();
  }

  async function remove(event: React.MouseEvent): Promise<void> {
    if (event.detail === 0 && performance.now() - mountAtRef.current < MOUNT_CLICK_GRACE_MS) {
      event.preventDefault();
      return;
    }
    if (!task) return;
    setBusy(true);
    setError(null);
    const failure = await removeTask(task.id, { force: dirty, deleteBranch });
    setBusy(false);
    if (failure?.kind === "worktree-dirty") {
      setDirty(true);
      return;
    }
    if (failure) {
      setError(failure.message);
      return;
    }
    close();
  }

  const branch = task?.task?.branch ?? "";

  return (
    <Dialog
      open={task !== undefined}
      onOpenChange={(next) => {
        if (!next) cancel();
      }}
      size="sm"
    >
      <DialogHeader
        title={t("task.remove_title", { name: task?.name ?? "" })}
        description={
          <>
            {t("task.remove_description")}
            <ClosingConversations conversations={closing} />
            {unsavedCount > 0 && (
              <span className="mt-2 block text-foreground">
                {t("workspace.remove_unsaved", { count: unsavedCount })}
              </span>
            )}
            {dirty && (
              <span className="mt-2 block text-[var(--state-warning-fg)]">
                {t("task.remove_dirty")}
              </span>
            )}
          </>
        }
      />
      <label htmlFor={branchId} className="mt-4 flex items-center gap-2 cursor-pointer">
        <Checkbox
          id={branchId}
          checked={deleteBranch}
          disabled={busy}
          onCheckedChange={(value) => setDeleteBranch(value === true)}
        />
        <span className="text-app-ui-sm text-foreground">
          {t("task.remove_branch", { branch })}
        </span>
      </label>
      {error !== null && (
        <p role="alert" className="mt-3 text-app-ui-sm text-destructive">
          {error}
        </p>
      )}
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="ghost" size="sm" disabled={busy} onClick={cancel} autoFocus>
          {t("action.cancel")}
        </Button>
        <Button
          variant={dirty ? "destructive" : "default"}
          size="sm"
          disabled={busy}
          onClick={(event) => void remove(event)}
        >
          {dirty ? t("task.remove_anyway") : t("task.remove")}
        </Button>
      </div>
    </Dialog>
  );
}

export interface ClosingConversation {
  readonly key: string;
  readonly title: string;
  readonly parent?: string;
}

const MAX_STEPS = 8;

export function closingConversations(
  families: readonly SessionFamily[],
  taskId: string,
): ClosingConversation[] {
  const sessions = families
    .flatMap((family) => family.worktrees.flatMap((worktree) => worktree.sessions))
    .filter(listed);
  const byTab = new Map(sessions.map((session) => [session.tabId, session]));
  return sessions
    .filter((session) => session.workspaceId === taskId)
    .map((session) => {
      let current = session;
      for (let step = 0; step < MAX_STEPS; step++) {
        const opener = current.parent;
        const parent = opener?.tabId && !opener.device ? byTab.get(opener.tabId) : undefined;
        if (!parent || parent === session) break;
        if (parent.workspaceId !== taskId)
          return { key: session.key, title: session.title, parent: parent.title };
        current = parent;
      }
      return { key: session.key, title: session.title };
    });
}

const SHOWN = 4;

export function ClosingConversations({
  conversations,
}: {
  conversations: readonly ClosingConversation[];
}) {
  const { t } = useTranslation();
  if (conversations.length === 0) return null;
  const under = new Map<string, number>();
  for (const { parent } of conversations) {
    if (parent) under.set(parent, (under.get(parent) ?? 0) + 1);
  }
  const summary = [
    t("task.remove_agents", { count: conversations.length }),
    ...[...under].map(([name, count]) => t("task.remove_agents_under", { name, count })),
  ].join(" · ");
  const more = conversations.length - SHOWN;
  return (
    <span className="mt-2 block text-foreground" data-testid="remove-task-conversations">
      <span className="block">{summary}</span>
      {conversations.slice(0, SHOWN).map(({ key, title, parent }) => (
        <span key={key} className="flex min-w-0 items-center gap-1.5 pl-2">
          <span className="min-w-0 truncate" title={title}>
            {title}
          </span>
          {parent && (
            <span className="max-w-[45%] shrink-0 truncate text-muted-foreground" title={parent}>
              {t("agentView.list.parent", { name: parent })}
            </span>
          )}
        </span>
      ))}
      {more > 0 && (
        <span className="block pl-2 text-muted-foreground">
          {t("task.remove_agents_more", { count: more })}
        </span>
      )}
    </span>
  );
}
