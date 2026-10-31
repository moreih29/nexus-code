// Remove Task dialog — deletes a task's worktree and, when asked, its branch.
//
// Mounted once in GlobalRoots; `useTaskUIStore.openRemoveTask(taskId)` opens
// it. A worktree with changes turns the dialog into a second confirmation,
// since deleting it throws the changes away.

import { Dialog as RadixDialog } from "radix-ui";
import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { MOUNT_CLICK_GRACE_MS } from "@/components/ui/confirm-dialog";
import { Dialog } from "@/components/ui/dialog";
import { countUnsavedBuffers } from "../../services/editor/save/unsaved-guard";
import { removeTask } from "../../services/workspace/tasks";
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
  const mountAtRef = useRef(0);
  const branchId = useId();

  useEffect(() => {
    if (taskId === null) return;
    setDeleteBranch(false);
    setDirty(false);
    setBusy(false);
    setError(null);
    setUnsavedCount(countUnsavedBuffers(taskId));
    mountAtRef.current = performance.now();
  }, [taskId]);

  function cancel(): void {
    if (!busy) close();
  }

  async function remove(event: React.MouseEvent): Promise<void> {
    // Same guard as ConfirmDialog: a keyboard-synthesized click right after
    // the dialog opens is the residue of the key that opened it.
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
      aria-describedby={undefined}
    >
      <RadixDialog.Title className="text-app-body-emphasis text-foreground">
        {t("task.remove_title", { name: task?.name ?? "" })}
      </RadixDialog.Title>
      <RadixDialog.Description className="mt-2 text-app-ui-sm text-muted-foreground">
        {t("task.remove_description")}
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
      </RadixDialog.Description>
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
        {/* Focus starts on Cancel, as in the Remove Workspace dialog: a key
            repeat must not delete the worktree. */}
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
