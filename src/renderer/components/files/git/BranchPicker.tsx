/**
 * BranchPicker — VS Code-style "Checkout to..." quick-pick (matches the
 * `git.checkout` command). Combines checkout (existing local/remote) and
 * create-branch (new name) in a single filtered list with keyboard navigation.
 */

import { AlertDialog as RadixAlertDialog } from "radix-ui";
import type React from "react";
import type { Dispatch, SetStateAction } from "react";
import { useMemo, useState } from "react";
import type { GitStoreError } from "../../../state/stores/git";
import { useGitStore } from "../../../state/stores/git";
import { Button } from "../../ui/button";
import { CommandPalette } from "../../ui/palette/command-palette";
import { PromptDialog, type PromptRequest } from "../../ui/prompt-dialog";
import { type BranchPickItem, createBranchPickerSource } from "./branch-picker-source";

interface BranchPickerProps {
  workspaceId: string;
  open: boolean;
  onClose: () => void;
  mode?: "checkout" | "select-ref";
  title?: string;
  placeholder?: string;
  footer?: React.ReactNode;
  onSelectRef?: (ref: string) => void;
}

export function BranchPicker({
  workspaceId,
  open,
  onClose,
  mode = "checkout",
  title,
  placeholder,
  footer,
  onSelectRef,
}: BranchPickerProps) {
  const listBranches = useGitStore((state) => state.listBranches);
  const checkout = useGitStore((state) => state.checkout);
  const checkoutTracking = useGitStore((state) => state.checkoutTracking);
  const createBranch = useGitStore((state) => state.createBranch);
  const deleteBranch = useGitStore((state) => state.deleteBranch);
  const deleteRemoteBranch = useGitStore((state) => state.deleteRemoteBranch);
  const renameBranch = useGitStore((state) => state.renameBranch);
  const setUpstream = useGitStore((state) => state.setUpstream);
  const inFlightKind = useGitStore((state) => state.sessions.get(workspaceId)?.inFlightOp?.kind);
  const [deleteRequest, setDeleteRequest] = useState<BranchDeleteRequest | null>(null);
  const [promptRequest, setPromptRequest] = useState<BranchPromptRequest | null>(null);

  const source = useMemo(
    () =>
      createBranchPickerSource({
        workspaceId,
        listBranches,
        checkout,
        checkoutTracking,
        createBranch,
        title,
        placeholder,
        allowCreate: mode !== "select-ref",
        acceptRef:
          mode === "select-ref"
            ? (ref) => {
                onSelectRef?.(ref);
              }
            : undefined,
        requestDelete: (item) => {
          if (mode === "select-ref") return;
          const request = branchDeleteRequestFromItem(item);
          if (request) setDeleteRequest(request);
        },
        requestRename: (item) => {
          if (mode === "select-ref") return;
          if (item.action.kind !== "checkout") return;
          setPromptRequest({
            kind: "rename",
            branch: item.action.ref,
            prompt: {
              title: "Rename branch",
              description: `Rename '${item.action.ref}'.`,
              label: "New name",
              defaultValue: item.action.ref,
              confirmLabel: "Rename",
            },
          });
        },
        requestSetUpstream: (item) => {
          if (mode === "select-ref") return;
          if (item.action.kind !== "checkout") return;
          setPromptRequest({
            kind: "upstream",
            branch: item.action.ref,
            prompt: {
              title: "Set upstream",
              description: `Set upstream for '${item.action.ref}'. Leave empty to unset.`,
              label: "Upstream",
              placeholder: "origin/main",
              confirmLabel: "Set Upstream",
              allowEmpty: true,
            },
          });
        },
      }),
    [
      workspaceId,
      listBranches,
      checkout,
      checkoutTracking,
      createBranch,
      title,
      placeholder,
      mode,
      onSelectRef,
    ],
  );
  const footerText =
    footer ??
    (mode === "select-ref"
      ? "Enter view history · Working tree is not changed"
      : "Enter checkout/create · Cmd/Ctrl+Backspace delete · Cmd/Ctrl+R rename · Cmd/Ctrl+U upstream");

  return (
    <>
      <CommandPalette<BranchPickItem>
        open={open}
        source={source}
        onClose={onClose}
        footer={footerText}
      />
      <BranchDeleteConfirmDialog
        request={deleteRequest}
        busy={inFlightKind === "deleteBranch" || inFlightKind === "deleteRemoteBranch"}
        onToggleForce={(force) =>
          setDeleteRequest((current) =>
            current?.kind === "local" ? { ...current, force } : current,
          )
        }
        onCancel={() => setDeleteRequest(null)}
        onConfirm={(request) => {
          void confirmBranchDelete(request, {
            workspaceId,
            deleteBranch,
            deleteRemoteBranch,
            setDeleteRequest,
          });
        }}
      />
      <PromptDialog
        request={promptRequest?.prompt ?? null}
        busy={inFlightKind === "renameBranch" || inFlightKind === "setUpstream"}
        onCancel={() => setPromptRequest(null)}
        onConfirm={(value) => {
          const request = promptRequest;
          setPromptRequest(null);
          if (!request) return;
          if (request.kind === "rename") {
            void renameBranch(workspaceId, request.branch, value).catch(() => {});
          } else {
            void setUpstream(workspaceId, request.branch, value.trim() || null).catch(() => {});
          }
        }}
      />
    </>
  );
}

type BranchDeleteRequest =
  | {
      kind: "local";
      name: string;
      force: boolean;
      forceAvailable: boolean;
      errorMessage?: string;
    }
  | {
      kind: "remote";
      remote: string;
      name: string;
    };

type BranchPromptRequest =
  | { kind: "rename"; branch: string; prompt: PromptRequest }
  | { kind: "upstream"; branch: string; prompt: PromptRequest };

interface ConfirmDeleteDeps {
  workspaceId: string;
  deleteBranch: (workspaceId: string, name: string, force?: boolean) => Promise<void>;
  deleteRemoteBranch: (workspaceId: string, remote: string, name: string) => Promise<void>;
  setDeleteRequest: Dispatch<SetStateAction<BranchDeleteRequest | null>>;
}

/**
 * Converts a branch picker row into the correct local or remote delete request.
 */
function branchDeleteRequestFromItem(item: BranchPickItem): BranchDeleteRequest | null {
  if (item.kindLabel === "current") return null;
  if (item.action.kind === "checkout") {
    return { kind: "local", name: item.action.ref, force: false, forceAvailable: false };
  }
  if (item.action.kind === "checkout-tracking") {
    const parsed = splitRemoteRef(item.action.remoteRef);
    if (!parsed) return null;
    return { kind: "remote", ...parsed };
  }
  return null;
}

/**
 * Runs a local/remote delete request and upgrades unmerged local failures into
 * the explicit force-delete confirmation step.
 */
async function confirmBranchDelete(
  request: BranchDeleteRequest,
  deps: ConfirmDeleteDeps,
): Promise<void> {
  try {
    if (request.kind === "remote") {
      await deps.deleteRemoteBranch(deps.workspaceId, request.remote, request.name);
    } else {
      await deps.deleteBranch(deps.workspaceId, request.name, request.force);
    }
    deps.setDeleteRequest(null);
  } catch (error) {
    const gitError = gitStoreErrorFromUnknown(error);
    if (request.kind === "local" && gitError.kind === "branch-not-fully-merged" && !request.force) {
      deps.setDeleteRequest({
        ...request,
        forceAvailable: true,
        errorMessage: gitError.message,
      });
      return;
    }
    deps.setDeleteRequest(null);
  }
}

/**
 * Dialog for local and remote branch deletion. Local unmerged branches get an
 * explicit second step with a force-delete checkbox.
 */
function BranchDeleteConfirmDialog({
  request,
  busy,
  onToggleForce,
  onCancel,
  onConfirm,
}: {
  request: BranchDeleteRequest | null;
  busy?: boolean;
  onToggleForce: (force: boolean) => void;
  onCancel: () => void;
  onConfirm: (request: BranchDeleteRequest) => void;
}) {
  const isLocal = request?.kind === "local";
  const forceRequired = isLocal && request.forceAvailable;
  const confirmDisabled = busy || (forceRequired && !request.force);
  const title =
    request?.kind === "remote"
      ? `Delete remote branch '${request.remote}/${request.name}'?`
      : `Delete branch '${request?.name ?? ""}'?`;
  const description =
    request?.kind === "remote"
      ? "This affects the remote and cannot be undone locally."
      : "This deletes the local branch. The commits remain reachable if another ref contains them.";

  return (
    <RadixAlertDialog.Root
      open={request !== null}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onCancel();
      }}
    >
      <RadixAlertDialog.Portal>
        <RadixAlertDialog.Overlay className="fixed inset-0 z-50 bg-black/40" />
        <RadixAlertDialog.Content className="fixed left-1/2 top-1/2 z-50 w-[440px] max-w-[90vw] -translate-x-1/2 -translate-y-1/2 rounded-md border border-mist-border bg-background p-5 text-foreground shadow-lg outline-none">
          <RadixAlertDialog.Title className="text-app-body-emphasis text-foreground">
            {title}
          </RadixAlertDialog.Title>
          <RadixAlertDialog.Description className="mt-2 text-app-ui-sm text-muted-foreground">
            {description}
          </RadixAlertDialog.Description>
          {forceRequired ? (
            <div className="mt-4 rounded-sm border border-mist-border bg-frosted-veil p-3">
              <p className="text-app-ui-sm text-muted-foreground">
                {request.errorMessage ?? "Branch is not fully merged."}
              </p>
              <label className="mt-3 flex items-center gap-2 text-app-ui-sm text-foreground">
                <input
                  type="checkbox"
                  checked={request.force}
                  onChange={(event) => onToggleForce(event.target.checked)}
                  disabled={busy}
                />
                Force delete
              </label>
              {request.force ? (
                <p className="mt-2 text-app-ui-xs text-muted-foreground">
                  Commits unique to this branch may become unreachable.
                </p>
              ) : null}
            </div>
          ) : null}
          <div className="mt-5 flex justify-end gap-2">
            <RadixAlertDialog.Cancel asChild>
              <Button type="button" variant="ghost" size="sm" autoFocus disabled={busy}>
                Cancel
              </Button>
            </RadixAlertDialog.Cancel>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              disabled={confirmDisabled}
              onClick={() => {
                if (request) onConfirm(request);
              }}
            >
              {request?.kind === "local" && request.force ? "Force Delete" : "Delete"}
            </Button>
          </div>
        </RadixAlertDialog.Content>
      </RadixAlertDialog.Portal>
    </RadixAlertDialog.Root>
  );
}

/**
 * Splits a remote ref into remote name and remote branch path.
 */
function splitRemoteRef(remoteRef: string): { remote: string; name: string } | null {
  const slash = remoteRef.indexOf("/");
  if (slash <= 0 || slash === remoteRef.length - 1) return null;
  return { remote: remoteRef.slice(0, slash), name: remoteRef.slice(slash + 1) };
}

/**
 * Normalizes thrown IPC errors into the subset needed by the delete flow.
 */
function gitStoreErrorFromUnknown(error: unknown): Pick<GitStoreError, "kind" | "message"> {
  if (typeof error === "object" && error !== null) {
    const record = error as { kind?: unknown; message?: unknown };
    return {
      kind: typeof record.kind === "string" ? record.kind : "unknown",
      message: typeof record.message === "string" ? record.message : "Git operation failed",
    };
  }
  return { kind: "unknown", message: String(error) };
}
