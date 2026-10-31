// New Task dialog — a name, and the first prompt for the task's coding agent.
//
// Mounted once in GlobalRoots; `useTaskUIStore.openNewTask(parentId)` opens
// it. Failures stay in the dialog so the name can be fixed and sent again.

import i18next from "i18next";
import { Dialog as RadixDialog } from "radix-ui";
import type React from "react";
import { useEffect, useMemo, useState } from "react";
import { Dialog } from "@/components/ui/dialog";
import {
  FormDialogContent,
  type FormDialogField,
  type FormDialogValues,
  handleFormDialogOpenChange,
  isFormDialogSubmitDisabled,
} from "@/components/ui/form-dialog";
import { createTask, type TaskFailure } from "../../services/workspace/tasks";
import { useGitStore } from "../../state/stores/git/index";
import { useTaskUIStore } from "../../state/stores/task-ui";
import { DEFAULT_TASK_AGENT_COMMAND, useTerminalStore } from "../../state/stores/terminal";
import { useWorkspacesStore } from "../../state/stores/workspaces";

const EMPTY_VALUES: FormDialogValues = { name: "", prompt: "" };

/** The dialog's fields; no prompt when the task agent command is empty. */
export function newTaskFields(command: string): readonly FormDialogField[] {
  const t = i18next.t.bind(i18next);
  const name: FormDialogField = {
    name: "name",
    label: t("task.name_label"),
    placeholder: t("task.name_placeholder"),
    helperText: t("task.name_helper"),
    autoFocus: true,
  };
  if (command === "") return [name];
  return [
    name,
    {
      name: "prompt",
      label: t("task.prompt_label"),
      placeholder: t("task.prompt_placeholder"),
      helperText: t("task.prompt_helper", { command }),
      required: false,
    },
  ];
}

/** The message for a failed create; the raw one for errors without copy. */
export function taskFailureMessage(failure: TaskFailure, workspaceName: string): string {
  const t = i18next.t.bind(i18next);
  switch (failure.kind) {
    case "not-a-repo":
      return t("task.error_not_a_repo", { name: workspaceName });
    case "not-connected":
      return t("task.error_not_connected", { name: workspaceName });
    case "invalid-name":
      return t("task.error_invalid_name");
    default:
      return failure.message;
  }
}

export function NewTaskDialogRoot(): React.JSX.Element {
  const parentId = useTaskUIStore((s) => s.newTaskParentId);
  const close = useTaskUIStore((s) => s.closeNewTask);
  const parent = useWorkspacesStore((s) =>
    parentId === null ? undefined : s.workspaces.find((w) => w.id === parentId),
  );
  const branch = useGitStore((s) => {
    if (parentId === null) return null;
    const session = s.sessions.get(parentId);
    return session?.branchInfo?.current ?? session?.status?.branch?.current ?? null;
  });
  const command = useTerminalStore((s) =>
    (s.taskAgentCommand ?? DEFAULT_TASK_AGENT_COMMAND).trim(),
  );

  const [values, setValues] = useState<FormDialogValues>(EMPTY_VALUES);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fields = useMemo(() => newTaskFields(command), [command]);

  useEffect(() => {
    if (parentId === null) return;
    setValues(EMPTY_VALUES);
    setBusy(false);
    setError(null);
  }, [parentId]);

  function cancel(): void {
    if (!busy) close();
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!parent || isFormDialogSubmitDisabled(fields, values, busy)) return;
    setBusy(true);
    setError(null);
    const failure = await createTask(parent.id, values.name ?? "", values.prompt ?? "");
    setBusy(false);
    if (failure) {
      setError(taskFailureMessage(failure, parent.name));
      return;
    }
    close();
  }

  const title = i18next.t("task.new_title");
  const description = parent
    ? i18next.t("task.new_description", { name: parent.name, branch: branch ?? "HEAD" })
    : "";

  return (
    <Dialog
      open={parent !== undefined}
      onOpenChange={(nextOpen) => handleFormDialogOpenChange(nextOpen, cancel)}
      size="md"
    >
      <RadixDialog.Title className="sr-only">{title}</RadixDialog.Title>
      <RadixDialog.Description className="sr-only">{description}</RadixDialog.Description>
      <FormDialogContent
        title={title}
        description={description}
        fields={fields}
        values={values}
        busy={busy}
        submitLabel={i18next.t("task.create")}
        cancelLabel={i18next.t("action.cancel")}
        onValueChange={(name, value) => setValues((current) => ({ ...current, [name]: value }))}
        onCancel={cancel}
        onSubmit={(event) => void handleSubmit(event)}
      >
        {error !== null && (
          <p role="alert" className="text-app-ui-sm text-destructive">
            {error}
          </p>
        )}
      </FormDialogContent>
    </Dialog>
  );
}
