/**
 * BranchPicker — VS Code-style branch quick-pick. Switch mode matches the
 * `git.checkout` command; branch action modes reuse the same list chrome while
 * narrowing filter and accept behavior for rename/delete flows.
 */

import { AlertDialog as RadixAlertDialog } from "radix-ui";
import type React from "react";
import type { Dispatch, SetStateAction } from "react";
import { useMemo, useState } from "react";
import type { GitStoreError } from "../../../../state/stores/git";
import { useGitStore } from "../../../../state/stores/git";
import { Button } from "../../../ui/button";
import { DIALOG_OVERLAY_CLASS, dialogContentClass } from "../../../ui/dialog";
import { CommandPalette } from "../../../ui/palette/command-palette";
import { PromptDialog, type PromptRequest } from "../../../ui/prompt-dialog";
import {
  type BranchPickerSourceMode,
  type BranchPickItem,
  createBranchPickerSource,
} from "./picker-source";

interface BranchPickerProps {
  workspaceId: string;
  open: boolean;
  onClose: () => void;
  mode?: BranchPickerMode;
  title?: string;
  placeholder?: string;
  footer?: React.ReactNode;
  onSelectRef?: (ref: string) => void;
}

export type BranchPickerMode = BranchPickerSourceMode;

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
  const normalizedMode = normalizeBranchPickerMode(mode);

  const source = useMemo(
    () =>
      createBranchPickerSource({
        workspaceId,
        listBranches,
        checkout,
        checkoutTracking,
        createBranch,
        mode: normalizedMode,
        title,
        placeholder,
        allowCreate: normalizedMode === "switch",
        acceptRef:
          normalizedMode === "select-ref"
            ? (ref) => {
                onSelectRef?.(ref);
              }
            : undefined,
        requestDelete: (item) => {
          if (normalizedMode === "select-ref" || normalizedMode === "rename") return;
          const request = branchDeleteRequestFromItem(item);
          if (request) setDeleteRequest(request);
        },
        requestRename: (item) => {
          if (normalizedMode === "select-ref" || normalizedMode.startsWith("delete-")) return;
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
          if (normalizedMode !== "switch") return;
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
      normalizedMode,
      onSelectRef,
    ],
  );
  const footerText = footer ?? defaultFooterForMode(normalizedMode);

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

export type BranchDeleteRequest =
  | {
      kind: "local";
      name: string;
      force: boolean;
    }
  | {
      kind: "remote";
      remote: string;
      name: string;
    };

type BranchPromptRequest =
  | { kind: "rename"; branch: string; prompt: PromptRequest }
  | { kind: "upstream"; branch: string; prompt: PromptRequest };

export interface ConfirmDeleteDeps {
  workspaceId: string;
  deleteBranch: (workspaceId: string, name: string, force?: boolean) => Promise<void>;
  deleteRemoteBranch: (workspaceId: string, remote: string, name: string) => Promise<void>;
  setDeleteRequest: Dispatch<SetStateAction<BranchDeleteRequest | null>>;
}

/**
 * Keeps the legacy `checkout` spelling as a compatibility alias for the
 * default switch mode.
 */
function normalizeBranchPickerMode(
  mode: BranchPickerMode | undefined,
): Exclude<BranchPickerMode, "checkout"> {
  if (!mode || mode === "checkout") return "switch";
  return mode;
}

/**
 * Describes the shortcut footer for each branch picker mode.
 */
function defaultFooterForMode(mode: Exclude<BranchPickerMode, "checkout">): string {
  switch (mode) {
    case "switch":
      return "Enter checkout/create";
    case "select-ref":
      return "Enter view history · Working tree is not changed";
    case "rename":
      return "Enter rename selected branch";
    case "delete-local":
      return "Enter delete selected branch";
    case "delete-remote":
      return "Enter delete selected remote branch";
  }
}

/**
 * Converts a branch picker row into the correct local or remote delete request.
 */
export function branchDeleteRequestFromItem(item: BranchPickItem): BranchDeleteRequest | null {
  if (item.kindLabel === "current") return null;
  if (item.action.kind === "checkout") {
    return { kind: "local", name: item.action.ref, force: false };
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
export async function confirmBranchDelete(
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
        force: true,
      });
      return;
    }
    deps.setDeleteRequest(null);
  }
}

/**
 * Dialog for local and remote branch deletion. Local unmerged branches get an
 * explicit second step before retrying with force.
 */
function BranchDeleteConfirmDialog({
  request,
  busy,
  onCancel,
  onConfirm,
}: {
  request: BranchDeleteRequest | null;
  busy?: boolean;
  onCancel: () => void;
  onConfirm: (request: BranchDeleteRequest) => void;
}) {
  const view = buildBranchDeleteDialogView(request);
  const confirmDisabled = busy;

  return (
    <RadixAlertDialog.Root
      open={request !== null}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onCancel();
      }}
    >
      <RadixAlertDialog.Portal>
        <RadixAlertDialog.Overlay className={DIALOG_OVERLAY_CLASS} />
        <RadixAlertDialog.Content className={dialogContentClass("md", true)}>
          <RadixAlertDialog.Title className="text-app-body-emphasis text-foreground">
            {view.title}
          </RadixAlertDialog.Title>
          <RadixAlertDialog.Description className="mt-2 text-app-ui-sm text-muted-foreground">
            {view.description.map((line, index) => (
              <span key={line} className={index === 0 ? "block" : "mt-2 block"}>
                {line}
              </span>
            ))}
          </RadixAlertDialog.Description>
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
              {view.confirmLabel}
            </Button>
          </div>
        </RadixAlertDialog.Content>
      </RadixAlertDialog.Portal>
    </RadixAlertDialog.Root>
  );
}

export interface BranchDeleteDialogView {
  title: string;
  description: readonly string[];
  confirmLabel: string;
  forceWarning: boolean;
}

/**
 * Builds the delete modal copy so the warning step can be unit-tested without
 * mounting Radix portal internals.
 */
export function buildBranchDeleteDialogView(
  request: BranchDeleteRequest | null,
): BranchDeleteDialogView {
  if (request?.kind === "remote") {
    return {
      title: `Delete remote branch '${request.remote}/${request.name}'?`,
      description: ["This affects the remote and cannot be undone locally."],
      confirmLabel: "Delete",
      forceWarning: false,
    };
  }
  if (request?.kind === "local" && request.force) {
    return {
      title: "Branch is not fully merged",
      description: [
        `Branch '${request.name}' is not fully merged.`,
        "Delete anyway? Unmerged commits may be lost.",
      ],
      confirmLabel: "Delete",
      forceWarning: true,
    };
  }
  return {
    title: `Delete branch '${request?.name ?? ""}'?`,
    description: [
      "This deletes the local branch. The commits remain reachable if another ref contains them.",
    ],
    confirmLabel: "Delete",
    forceWarning: false,
  };
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
