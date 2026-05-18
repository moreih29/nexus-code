/**
 * BranchCreateDialog hosts the validated branch-name input shared by
 * Branch ▸ Create New Branch and Branch ▸ Create New Branch From.
 */
import { Dialog as RadixDialog } from "radix-ui";
import type React from "react";
import { useEffect, useMemo, useState } from "react";
import type { BranchList } from "../../../../../shared/git/types";
import type { CreateBranchOptions } from "../../../../state/stores/git";
import { Dialog } from "../../../ui/dialog";
import {
  FormDialogContent,
  type FormDialogField,
  type FormDialogValues,
  handleFormDialogOpenChange,
  isFormDialogSubmitDisabled,
} from "../../../ui/form-dialog";

export interface BranchCreateRequest {
  readonly fromRef?: string;
}

export interface BranchCreateFieldContext {
  readonly branchList: BranchList | null;
  readonly loadingExistingBranches?: boolean;
}

interface BranchCreateDialogProps {
  request: BranchCreateRequest | null;
  branchList: BranchList | null;
  loadingExistingBranches?: boolean;
  busy?: boolean;
  onCancel: () => void;
  onSubmit: (name: string) => void;
}

interface SubmitBranchCreateInput {
  workspaceId: string;
  name: string;
  fromRef?: string;
  createBranch: (
    workspaceId: string,
    name: string,
    checkoutOrOptions?: boolean | CreateBranchOptions,
  ) => Promise<void>;
}

/**
 * Builds the single field used by the branch-create dialog, including local
 * duplicate-name validation from the latest branch list.
 */
export function buildBranchCreateFields(
  context: BranchCreateFieldContext,
): readonly FormDialogField[] {
  return [
    {
      name: "name",
      label: "Branch name",
      placeholder: "feature/name",
      helperText: "Creates and checks out the new branch.",
      autoFocus: true,
      validate: (value) => validateBranchCreateName(value, context),
    },
  ];
}

/**
 * Returns the branch-create dialog title for the active create flow.
 */
function branchCreateDialogTitle(request: BranchCreateRequest | null): string {
  return request?.fromRef ? "Create branch from ref" : "Create branch";
}

/**
 * Returns create-flow copy that makes the checkout side effect explicit.
 */
export function branchCreateDialogDescription(request: BranchCreateRequest | null): string {
  if (request?.fromRef) {
    return `Create and check out a new branch from '${request.fromRef}'.`;
  }
  return "Create and check out a new branch from the current HEAD.";
}

/**
 * Validates names that can be checked locally before invoking Git.
 */
function validateBranchCreateName(
  value: string,
  context: BranchCreateFieldContext,
): string | null {
  const name = value.trim();
  if (name.length === 0) return "Required";
  if (context.loadingExistingBranches) return "Checking existing branches…";
  if (!context.branchList) return null;
  if (context.branchList.current?.current === name) {
    return `Branch '${name}' is already current.`;
  }
  if (context.branchList.local.includes(name)) {
    return `A branch named '${name}' already exists.`;
  }
  return null;
}

/**
 * Calls the store createBranch action with the checked-out branch behavior used
 * by VS Code's create branch commands.
 */
export async function submitBranchCreate({
  workspaceId,
  name,
  fromRef,
  createBranch,
}: SubmitBranchCreateInput): Promise<void> {
  const trimmed = name.trim();
  if (trimmed.length === 0) return;

  const options: CreateBranchOptions = { checkout: true };
  if (fromRef) options.fromRef = fromRef;
  await createBranch(workspaceId, trimmed, options);
}

/**
 * Renders the modal branch-name form while preserving the typed value if the
 * async branch list arrives after the dialog opens.
 */
export function BranchCreateDialog({
  request,
  branchList,
  loadingExistingBranches = false,
  busy = false,
  onCancel,
  onSubmit,
}: BranchCreateDialogProps): React.JSX.Element {
  const [values, setValues] = useState<FormDialogValues>({ name: "" });
  const fields = useMemo(
    () => buildBranchCreateFields({ branchList, loadingExistingBranches }),
    [branchList, loadingExistingBranches],
  );

  useEffect(() => {
    if (request) setValues({ name: "" });
  }, [request]);

  function handleValueChange(name: string, value: string): void {
    setValues((current) => ({ ...current, [name]: value }));
  }

  function handleSubmit(event: React.FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (isFormDialogSubmitDisabled(fields, values, busy)) return;
    onSubmit(values.name ?? "");
  }

  return (
    <Dialog
      open={request !== null}
      onOpenChange={(nextOpen) => handleFormDialogOpenChange(nextOpen, onCancel)}
      size="md"
    >
      <RadixDialog.Title className="sr-only">{branchCreateDialogTitle(request)}</RadixDialog.Title>
      <RadixDialog.Description className="sr-only">
        {branchCreateDialogDescription(request)}
      </RadixDialog.Description>
      <FormDialogContent
        title={branchCreateDialogTitle(request)}
        description={branchCreateDialogDescription(request)}
        fields={fields}
        values={values}
        busy={busy}
        submitLabel="Create"
        cancelLabel="Cancel"
        errorClassName="git-destructive-text"
        onValueChange={handleValueChange}
        onCancel={onCancel}
        onSubmit={handleSubmit}
      />
    </Dialog>
  );
}
