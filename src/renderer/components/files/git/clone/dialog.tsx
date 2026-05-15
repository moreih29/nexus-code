/**
 * CloneDialog — workspace-agnostic Git clone flow.
 *
 * The dialog owns form validation, progress/cancel state, and post-clone
 * workspace registration CTAs. Repository registration remains renderer-side:
 * clone completion calls workspace.create and, for opening actions,
 * workspace.activate as separate IPC calls.
 */
import { Dialog as RadixDialog } from "radix-ui";
import { useEffect, useMemo, useRef, useState } from "react";
import type {
  GitCloneStreamProgressEvent,
  GitCloneStreamResultEvent,
} from "../../../../../shared/types/git";
import type { WorkspaceMeta } from "../../../../../shared/types/workspace";
import { type IpcStreamHandle, ipcCall, ipcStream } from "../../../../ipc/client";
import { useActiveStore } from "../../../../state/stores/active";
import { useGitStore } from "../../../../state/stores/git";
import { useWorkspacesStore } from "../../../../state/stores/workspaces";
import { Button } from "../../../ui/button";
import {
  FormDialogContent,
  type FormDialogField,
  type FormDialogValues,
  getFormDialogFieldStates,
  handleFormDialogOpenChange,
  initialFormDialogValues,
  isFormDialogSubmitDisabled,
} from "../../../ui/form-dialog";
import { closeCloneDialog, isCloneDialogOpen, subscribeCloneDialog } from "./dialog-state";
import {
  type ClonePostCloneAction,
  CloneProgressContent,
  type CloneProgressState,
  CloneSuccessContent,
  type CloneSuccessState,
} from "./dialog-status-views";
import {
  createCloneFormFields,
  deriveFolderNameFromUrl,
  isGitSessionDirty,
  parentDirectoryOf,
  previewClonePath,
} from "./form-utils";
import { ConfirmDiscardDialog, type DiscardConfirmRequest } from "./confirm-discard-dialog";

export type { ClonePostCloneAction };

interface CloneDialogProps {
  open: boolean;
  onClose: () => void;
}

interface CloneWorkspaceActionDeps {
  readonly createWorkspace: (args: { rootPath: string; name?: string }) => Promise<WorkspaceMeta>;
  readonly activateWorkspace: (args: { id: string }) => Promise<void>;
  readonly openNewWindow?: () => Promise<unknown>;
  readonly upsertWorkspace?: (meta: WorkspaceMeta) => void;
  readonly setActiveWorkspaceId?: (id: string) => void;
}

let cloneCtaDefault: ClonePostCloneAction = "new-window";

/** Mounts the singleton Clone dialog and subscribes to command/menu open events. */
export function CloneDialogRoot(): React.JSX.Element {
  const [open, setOpen] = useState(isCloneDialogOpen);

  useEffect(() => subscribeCloneDialog(() => setOpen(isCloneDialogOpen())), []);

  return <CloneDialog open={open} onClose={closeCloneDialog} />;
}

/** Returns the session-scoped default CTA selected after the previous clone. */
export function getCloneCtaDefault(): ClonePostCloneAction {
  return cloneCtaDefault;
}

/** Persists the Clone success CTA default for the current renderer session. */
export function setCloneCtaDefault(action: ClonePostCloneAction): void {
  cloneCtaDefault = action;
}

/**
 * Registers a cloned folder as a workspace and optionally opens it.
 */
export async function runPostCloneWorkspaceAction(
  action: ClonePostCloneAction,
  clone: { absPath: string; name?: string },
  deps: CloneWorkspaceActionDeps,
): Promise<WorkspaceMeta> {
  const meta = await deps.createWorkspace({ rootPath: clone.absPath, name: clone.name });
  deps.upsertWorkspace?.(meta);

  if (action === "add-workspace") {
    return meta;
  }

  await deps.activateWorkspace({ id: meta.id });
  if (action === "current-window") {
    deps.setActiveWorkspaceId?.(meta.id);
  } else {
    await deps.openNewWindow?.();
  }

  return meta;
}

/**
 * Renders the full Clone dialog. Exported for tests; normally use
 * CloneDialogRoot so commands and menus can open the singleton instance.
 */
export function CloneDialog({ open, onClose }: CloneDialogProps): React.JSX.Element {
  const activeWorkspaceId = useActiveStore((state) => state.activeWorkspaceId);
  const setActiveWorkspaceId = useActiveStore((state) => state.setActiveWorkspaceId);
  const workspaces = useWorkspacesStore((state) => state.workspaces);
  const activeWorkspace = activeWorkspaceId
    ? workspaces.find((workspace) => workspace.id === activeWorkspaceId)
    : undefined;
  const cloneWorkspaceId =
    activeWorkspace?.location.kind === "local" ? activeWorkspace.id : undefined;
  const upsertWorkspace = useWorkspacesStore((state) => state.upsert);
  const activeGitSession = useGitStore((state) =>
    activeWorkspaceId ? state.sessions.get(activeWorkspaceId) : null,
  );
  const fields = useMemo(() => createCloneFormFields(), []);
  const [values, setValues] = useState<FormDialogValues>(() =>
    initialCloneFormValues(workspaces, activeWorkspaceId),
  );
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [recurseSubmodules, setRecurseSubmodules] = useState(false);
  const [progress, setProgress] = useState<CloneProgressState>({
    phase: null,
    pct: null,
    cancelling: false,
  });
  const [success, setSuccess] = useState<CloneSuccessState | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [confirmCancel, setConfirmCancel] = useState<DiscardConfirmRequest | null>(null);
  const [ctaDefault, setCtaDefault] = useState(getCloneCtaDefault);
  const [postCloneBusy, setPostCloneBusy] = useState<ClonePostCloneAction | null>(null);
  const cloneStreamRef = useRef<IpcStreamHandle<
    GitCloneStreamProgressEvent,
    GitCloneStreamResultEvent
  > | null>(null);

  useEffect(() => {
    if (!open) return;
    setValues(initialCloneFormValues(workspaces, activeWorkspaceId));
    setAdvancedOpen(false);
    setRecurseSubmodules(false);
    setProgress({ phase: null, pct: null, cancelling: false });
    setSuccess(null);
    setErrorMessage(null);
    setConfirmCancel(null);
    setPostCloneBusy(null);
    setCtaDefault(getCloneCtaDefault());
  }, [open, workspaces, activeWorkspaceId]);

  const currentWindowDirty = activeGitSession ? isGitSessionDirty(activeGitSession.status) : false;

  /** Updates one form field and keeps the folder name derived until edited. */
  function updateValue(name: string, value: string): void {
    setValues((current) => {
      if (name !== "url") return { ...current, [name]: value };
      const previousDerived = deriveFolderNameFromUrl(current.url ?? "");
      const nextDerived = deriveFolderNameFromUrl(value);
      const shouldUpdateName = !current.name || current.name === previousDerived;
      return {
        ...current,
        url: value,
        ...(shouldUpdateName ? { name: nextDerived } : {}),
      };
    });
  }

  /** Opens the native directory chooser for the clone parent folder. */
  async function chooseParent(): Promise<void> {
    try {
      const { canceled, filePaths } = await ipcCall("dialog", "showOpenDirectory", {
        title: "Choose parent folder",
        defaultPath: values.parent || undefined,
      });
      if (!canceled && filePaths[0]) updateValue("parent", filePaths[0]);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Folder picker unavailable.");
    }
  }

  /** Starts git.stream.clone and transitions the dialog into progress mode. */
  async function submitClone(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (isFormDialogSubmitDisabled(fields, values)) return;

    setErrorMessage(null);
    setSuccess(null);
    setProgress({ phase: null, pct: null, cancelling: false });

    const handle = ipcStream("git", "clone", {
      workspaceId: cloneWorkspaceId,
      url: values.url.trim(),
      destination: values.parent.trim(),
      name: values.name.trim(),
      branch: values.branch.trim() || undefined,
      recurseSubmodules,
    });
    cloneStreamRef.current = handle;

    handle.onProgress((event) => {
      if (event.kind === "phase") {
        setProgress((current) => ({ ...current, phase: event.phase }));
      } else if (event.kind === "progress") {
        setProgress((current) => ({
          ...current,
          phase: event.phase,
          pct: Math.max(current.pct ?? 0, event.pct),
        }));
      }
    });

    try {
      const result = await handle.promise;
      cloneStreamRef.current = null;
      if (result.kind === "complete") {
        setSuccess({ absPath: result.absPath, name: values.name.trim() });
        return;
      }
      setProgress({ phase: null, pct: null, cancelling: false });
      setErrorMessage(
        result.cleaned
          ? "Clone cancelled. Partial folder removed."
          : "Clone cancelled. Partial folder could not be removed.",
      );
    } catch (error) {
      cloneStreamRef.current = null;
      setProgress({ phase: null, pct: null, cancelling: false });
      setErrorMessage(error instanceof Error ? error.message : "Clone failed.");
    }
  }

  /** Requests cancellation, confirming first when the clone is past halfway. */
  function requestCancelClone(): void {
    if ((progress.pct ?? 0) > 50) {
      setConfirmCancel({
        title: "Cancel clone?",
        description:
          "More than half of the repository has downloaded. Cancelling removes the partial clone folder.",
        relPaths: [],
        confirmLabel: "Cancel clone",
      });
      return;
    }
    cancelClone();
  }

  /** Sends the stream cancellation signal while keeping the dialog open. */
  function cancelClone(): void {
    setConfirmCancel(null);
    setProgress((current) => ({ ...current, cancelling: true }));
    cloneStreamRef.current?.cancel();
  }

  /** Runs the selected post-clone workspace registration/open action. */
  async function choosePostCloneAction(action: ClonePostCloneAction): Promise<void> {
    if (!success) return;
    setPostCloneBusy(action);
    setErrorMessage(null);
    try {
      await runPostCloneWorkspaceAction(action, success, {
        createWorkspace: (args) => ipcCall("workspace", "create", args),
        activateWorkspace: (args) => ipcCall("workspace", "activate", args),
        openNewWindow: () => ipcCall("system", "openNewWindow", undefined),
        upsertWorkspace,
        setActiveWorkspaceId,
      });
      setCloneCtaDefault(action);
      setCtaDefault(action);
      onClose();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Could not add workspace.");
    } finally {
      setPostCloneBusy(null);
    }
  }

  const mode: CloneDialogMode = success ? "success" : cloneStreamRef.current ? "progress" : "form";

  return (
    <>
      <RadixDialog.Root
        open={open}
        onOpenChange={(nextOpen) => {
          if (mode === "progress" && !nextOpen) return;
          handleFormDialogOpenChange(nextOpen, onClose);
        }}
      >
        <RadixDialog.Portal>
          <RadixDialog.Overlay className="fixed inset-0 z-50 bg-black/40" />
          <RadixDialog.Content
            className="fixed left-1/2 top-1/2 z-50 w-[520px] max-w-[92vw] -translate-x-1/2 -translate-y-1/2 rounded-md border border-mist-border bg-background p-5 text-foreground shadow-lg outline-none"
            aria-label="Clone Repository"
          >
            <CloneDialogContent
              mode={mode}
              fields={fields}
              values={values}
              advancedOpen={advancedOpen}
              recurseSubmodules={recurseSubmodules}
              progress={progress}
              success={success}
              errorMessage={errorMessage}
              ctaDefault={ctaDefault}
              postCloneBusy={postCloneBusy}
              currentWindowDirty={currentWindowDirty}
              onValueChange={updateValue}
              onChooseParent={() => void chooseParent()}
              onToggleAdvanced={() => setAdvancedOpen((current) => !current)}
              onRecurseSubmodulesChange={setRecurseSubmodules}
              onCancel={onClose}
              onSubmit={(event) => void submitClone(event)}
              onCancelClone={requestCancelClone}
              onPostCloneAction={(action) => void choosePostCloneAction(action)}
            />
          </RadixDialog.Content>
        </RadixDialog.Portal>
      </RadixDialog.Root>
      <ConfirmDiscardDialog
        request={confirmCancel}
        onCancel={() => setConfirmCancel(null)}
        onConfirm={cancelClone}
      />
    </>
  );
}

type CloneDialogMode = "form" | "progress" | "success";

interface CloneDialogContentProps {
  readonly mode: CloneDialogMode;
  readonly fields: readonly FormDialogField[];
  readonly values: FormDialogValues;
  readonly advancedOpen: boolean;
  readonly recurseSubmodules: boolean;
  readonly progress: CloneProgressState;
  readonly success: CloneSuccessState | null;
  readonly errorMessage: string | null;
  readonly ctaDefault: ClonePostCloneAction;
  readonly postCloneBusy: ClonePostCloneAction | null;
  readonly currentWindowDirty: boolean;
  readonly onValueChange: (name: string, value: string) => void;
  readonly onChooseParent: () => void;
  readonly onToggleAdvanced: () => void;
  readonly onRecurseSubmodulesChange: (checked: boolean) => void;
  readonly onCancel: () => void;
  readonly onSubmit: (event: React.FormEvent<HTMLFormElement>) => void;
  readonly onCancelClone: () => void;
  readonly onPostCloneAction: (action: ClonePostCloneAction) => void;
}

/** Renders the testable body for form, progress, and success states. */
export function CloneDialogContent({
  mode,
  fields,
  values,
  advancedOpen,
  recurseSubmodules,
  progress,
  success,
  errorMessage,
  ctaDefault,
  postCloneBusy,
  currentWindowDirty,
  onValueChange,
  onChooseParent,
  onToggleAdvanced,
  onRecurseSubmodulesChange,
  onCancel,
  onSubmit,
  onCancelClone,
  onPostCloneAction,
}: CloneDialogContentProps): React.JSX.Element {
  if (mode === "progress") {
    return (
      <CloneProgressContent
        progress={progress}
        errorMessage={errorMessage}
        onCancelClone={onCancelClone}
      />
    );
  }

  if (mode === "success" && success) {
    return (
      <CloneSuccessContent
        success={success}
        errorMessage={errorMessage}
        ctaDefault={ctaDefault}
        postCloneBusy={postCloneBusy}
        currentWindowDirty={currentWindowDirty}
        onPostCloneAction={onPostCloneAction}
      />
    );
  }

  const preview = previewClonePath(values.parent, values.name);
  const fieldStates = getFormDialogFieldStates(fields, values);

  return (
    <FormDialogContent
      title="Clone Repository"
      description="Create a local checkout from a remote Git URL."
      fields={fields}
      values={values}
      submitLabel="Clone"
      cancelLabel="Cancel"
      errorClassName="git-destructive-text"
      onValueChange={onValueChange}
      onCancel={onCancel}
      onSubmit={onSubmit}
      renderFieldAccessory={(state) =>
        state.field.name === "parent" ? (
          <Button type="button" variant="outline" size="sm" onClick={onChooseParent}>
            Choose…
          </Button>
        ) : null
      }
    >
      <p className="rounded-sm border border-mist-border bg-frosted-veil px-2 py-1 text-app-ui-xs text-muted-foreground">
        Will clone to: <span className="font-mono text-foreground">{preview || "—"}</span>
      </p>
      <div className="rounded-sm border border-mist-border bg-background/60 px-2 py-2">
        <button
          type="button"
          className="flex w-full items-center justify-between text-left text-app-ui-sm text-foreground"
          aria-expanded={advancedOpen}
          onClick={onToggleAdvanced}
        >
          <span>Advanced</span>
          <span aria-hidden="true">{advancedOpen ? "▾" : "▸"}</span>
        </button>
        {advancedOpen ? (
          <label className="mt-2 flex items-center gap-2 text-app-ui-sm text-muted-foreground">
            <input
              type="checkbox"
              checked={recurseSubmodules}
              onChange={(event) => onRecurseSubmodulesChange(event.currentTarget.checked)}
            />
            Initialize submodules recursively
          </label>
        ) : null}
      </div>
      {errorMessage ? (
        <p className="text-app-ui-xs git-destructive-text" role="alert">
          {errorMessage}
        </p>
      ) : null}
      <span className="sr-only">
        {fieldStates.some((state) => state.error) ? "Clone form has validation errors." : ""}
      </span>
    </FormDialogContent>
  );
}

/** Builds initial Clone form values from the active workspace if available. */
function initialCloneFormValues(
  workspaces: readonly WorkspaceMeta[],
  activeWorkspaceId: string | null,
): FormDialogValues {
  const active = activeWorkspaceId
    ? workspaces.find((workspace) => workspace.id === activeWorkspaceId)
    : undefined;
  return initialFormDialogValues(createCloneFormFields(), {
    parent: active ? parentDirectoryOf(active.rootPath) : "",
  });
}
