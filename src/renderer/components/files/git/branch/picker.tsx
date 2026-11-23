import i18next from "i18next";
import type React from "react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useGitStore } from "../../../../state/stores/git";
import { classifyGitError } from "../../../../utils/error-classification";
import { showConfirmDialog } from "../../../ui/confirm-dialog";
import { CommandPalette } from "../../../ui/palette/command-palette";
import { PromptDialog, type PromptRequest } from "../../../ui/prompt-dialog";
import {
  type BranchPickerSourceMode,
  type BranchPickItem,
  createBranchPickerSource,
  normalizeBranchPickerMode,
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
  const { t } = useTranslation("files");
  const listBranches = useGitStore((state) => state.listBranches);
  const checkout = useGitStore((state) => state.checkout);
  const checkoutTracking = useGitStore((state) => state.checkoutTracking);
  const createBranch = useGitStore((state) => state.createBranch);
  const deleteBranch = useGitStore((state) => state.deleteBranch);
  const deleteRemoteBranch = useGitStore((state) => state.deleteRemoteBranch);
  const renameBranch = useGitStore((state) => state.renameBranch);
  const setUpstream = useGitStore((state) => state.setUpstream);
  const inFlightKind = useGitStore((state) => state.sessions.get(workspaceId)?.inFlightOp?.kind);
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
          if (!request) return;
          void confirmBranchDelete(request, {
            workspaceId,
            deleteBranch,
            deleteRemoteBranch,
            confirm: showBranchDeleteConfirm,
          });
        },
        requestRename: (item) => {
          if (normalizedMode === "select-ref" || normalizedMode.startsWith("delete-")) return;
          if (item.action.kind !== "checkout") return;
          setPromptRequest({
            kind: "rename",
            branch: item.action.ref,
            prompt: {
              title: t("git.branch.picker.renameDialog.title"),
              description: t("git.branch.picker.renameDialog.description", {
                branch: item.action.ref,
              }),
              label: t("git.branch.picker.renameDialog.label"),
              defaultValue: item.action.ref,
              confirmLabel: t("git.branch.picker.renameDialog.confirmLabel"),
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
              title: t("git.branch.picker.upstreamDialog.title"),
              description: t("git.branch.picker.upstreamDialog.description", {
                branch: item.action.ref,
              }),
              label: t("git.branch.picker.upstreamDialog.label"),
              placeholder: t("git.branch.picker.upstreamDialog.placeholder"),
              confirmLabel: t("git.branch.picker.upstreamDialog.confirmLabel"),
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
      deleteBranch,
      deleteRemoteBranch,
      title,
      placeholder,
      normalizedMode,
      onSelectRef,
      t,
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
  confirm: (request: BranchDeleteRequest) => Promise<boolean>;
}

function defaultFooterForMode(mode: Exclude<BranchPickerMode, "checkout">): string {
  const t = i18next.t.bind(i18next);
  switch (mode) {
    case "switch":
      return t("files:git.branch.picker.footerCheckout");
    case "select-ref":
      return t("files:git.branch.picker.footerSelectRef");
    case "rename":
      return t("files:git.branch.picker.footerRename");
    case "delete-local":
      return t("files:git.branch.picker.footerDeleteLocal");
    case "delete-remote":
      return t("files:git.branch.picker.footerDeleteRemote");
  }
}

function branchDeleteRequestFromItem(item: BranchPickItem): BranchDeleteRequest | null {
  if (item.current) return null;
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

export async function confirmBranchDelete(
  request: BranchDeleteRequest,
  deps: ConfirmDeleteDeps,
): Promise<void> {
  if (!(await deps.confirm(request))) return;
  try {
    if (request.kind === "remote") {
      await deps.deleteRemoteBranch(deps.workspaceId, request.remote, request.name);
    } else {
      await deps.deleteBranch(deps.workspaceId, request.name, request.force);
    }
  } catch (error) {
    const gitError = classifyGitError(error);
    if (request.kind === "local" && gitError.kind === "branch-not-fully-merged" && !request.force) {
      await confirmBranchDelete({ ...request, force: true }, deps);
    }
  }
}

function showBranchDeleteConfirm(request: BranchDeleteRequest): Promise<boolean> {
  const view = buildBranchDeleteDialogView(request);
  const [description, ...rest] = view.description;
  return showConfirmDialog({
    title: view.title,
    description,
    hint: rest.length > 0 ? rest.join("\n") : undefined,
    cancelLabel: i18next.t("files:git.branch.picker.deleteConfirm.cancel"),
    confirmLabel: view.confirmLabel,
    variant: "destructive",
  });
}

export interface BranchDeleteDialogView {
  title: string;
  description: readonly string[];
  confirmLabel: string;
  forceWarning: boolean;
}

export function buildBranchDeleteDialogView(
  request: BranchDeleteRequest | null,
): BranchDeleteDialogView {
  const t = i18next.t.bind(i18next);
  if (request?.kind === "remote") {
    return {
      title: t("files:git.branch.picker.deleteConfirm.titleRemote", {
        remote: request.remote,
        name: request.name,
      }),
      description: [t("files:git.branch.picker.deleteConfirm.descriptionRemote")],
      confirmLabel: t("files:git.branch.picker.deleteConfirm.confirmLabel"),
      forceWarning: false,
    };
  }
  if (request?.kind === "local" && request.force) {
    return {
      title: t("files:git.branch.picker.deleteConfirm.titleForce"),
      description: [
        t("files:git.branch.picker.deleteConfirm.descriptionForce1", { name: request.name }),
        t("files:git.branch.picker.deleteConfirm.descriptionForce2"),
      ],
      confirmLabel: t("files:git.branch.picker.deleteConfirm.confirmLabel"),
      forceWarning: true,
    };
  }
  return {
    title: t("files:git.branch.picker.deleteConfirm.title", { name: request?.name ?? "" }),
    description: [t("files:git.branch.picker.deleteConfirm.description")],
    confirmLabel: t("files:git.branch.picker.deleteConfirm.confirmLabel"),
    forceWarning: false,
  };
}

function splitRemoteRef(remoteRef: string): { remote: string; name: string } | null {
  const slash = remoteRef.indexOf("/");
  if (slash <= 0 || slash === remoteRef.length - 1) return null;
  return { remote: remoteRef.slice(0, slash), name: remoteRef.slice(slash + 1) };
}
