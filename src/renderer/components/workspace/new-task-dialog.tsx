// New Task dialog — a name, the agent the task opens with (a Claude or Codex
// tab, or a terminal), and the first prompt for that agent.
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
import {
  DEFAULT_TASK_AGENT,
  TASK_AGENTS,
  type TaskAgent,
} from "../../../shared/sessions/task-agent";
import { createTask, type TaskFailure } from "../../services/workspace/tasks";
import { useGitStore } from "../../state/stores/git/index";
import { useTaskUIStore } from "../../state/stores/task-ui";
import { useTerminalStore } from "../../state/stores/terminal";
import { useWorkspacesStore } from "../../state/stores/workspaces";
import { SegmentedControl } from "../settings/segmented-control";

const EMPTY_VALUES: FormDialogValues = { name: "", prompt: "" };

/** The dialog's fields; no prompt for a terminal, which runs no agent. */
export function newTaskFields(agent: TaskAgent): readonly FormDialogField[] {
  const t = i18next.t.bind(i18next);
  const name: FormDialogField = {
    name: "name",
    label: t("task.name_label"),
    placeholder: t("task.name_placeholder"),
    helperText: t("task.name_helper"),
    autoFocus: true,
  };
  if (agent === "terminal") return [name];
  return [
    name,
    {
      name: "prompt",
      label: t("task.prompt_label"),
      placeholder: t("task.prompt_placeholder"),
      helperText: t("task.prompt_helper", { agent: t(`task.agents.${agent}`) }),
      required: false,
      multiline: true,
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
  const defaultAgent = useTerminalStore((s) => s.taskAgent ?? DEFAULT_TASK_AGENT);

  const [values, setValues] = useState<FormDialogValues>(EMPTY_VALUES);
  const [agent, setAgent] = useState<TaskAgent>(defaultAgent);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fields = useMemo(() => newTaskFields(agent), [agent]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: each opening starts from the setting; a change of it while open keeps the choice made
  useEffect(() => {
    if (parentId === null) return;
    setValues(EMPTY_VALUES);
    setAgent(defaultAgent);
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
    const prompt = agent === "terminal" ? "" : (values.prompt ?? "");
    const failure = await createTask(parent.id, values.name ?? "", prompt, agent);
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
        extraContent={
          <div className="flex flex-col items-start gap-2">
            <span className="text-app-ui-sm text-foreground">{i18next.t("task.agent_label")}</span>
            <SegmentedControl
              options={TASK_AGENTS.map((value) => ({
                value,
                label: i18next.t(`task.agents.${value}`),
              }))}
              value={agent}
              onChange={setAgent}
              label={i18next.t("task.agent_label")}
              disabled={busy}
            />
          </div>
        }
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
