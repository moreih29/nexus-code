/**
 * TagPicker hosts the tag quick-pick plus create and delete dialogs.
 */
import { AlertDialog as RadixAlertDialog } from "radix-ui";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import i18next from "i18next";
import { DIALOG_OVERLAY_CLASS, dialogContentClass } from "@/components/ui/dialog";
import type { Tag } from "../../../../../shared/git/types";
import { useGitStore } from "../../../../state/stores/git";
import { Button } from "../../../ui/button";
import { FormDialog, type FormDialogField, type FormDialogValues } from "../../../ui/form-dialog";
import { CommandPalette } from "../../../ui/palette/command-palette";
import { RefPicker } from "./ref-picker";
import {
  createTagPickerSource,
  type TagDeleteTarget,
  type TagPickerMode,
  type TagPickItem,
} from "./tag-picker-source";

interface TagPickerProps {
  workspaceId: string;
  open: boolean;
  mode?: TagPickerMode;
  selectedRemote?: string | null;
  onClose: () => void;
  onRequestReopen?: () => void;
  onRevealTag?: (tag: Tag) => void;
}

interface CreateTagRequest {
  defaultName?: string;
}

export type DeleteTagRequest =
  | {
      kind: "local";
      item: Extract<TagPickItem, { kind: "tag"; scope: "local" }>;
    }
  | {
      kind: "remote";
      item: Extract<TagPickItem, { kind: "tag"; scope: "remote" }>;
      remote: string;
    };

/**
 * Builds the create-tag FormDialog field model.
 */
export function buildCreateTagFields(): FormDialogField[] {
  const t = i18next.t.bind(i18next);
  return [
    {
      name: "name",
      label: t("files:git.tagPicker.createDialog.nameLabel"),
      placeholder: t("files:git.tagPicker.createDialog.namePlaceholder"),
    },
    {
      name: "message",
      label: t("files:git.tagPicker.createDialog.messageLabel"),
      placeholder: t("files:git.tagPicker.createDialog.messagePlaceholder"),
      helperText: t("files:git.tagPicker.createDialog.messageHelperText"),
      required: false,
      multiline: true,
    },
  ];
}

export function TagPicker({
  workspaceId,
  open,
  mode = "browse",
  selectedRemote = null,
  onClose,
  onRequestReopen,
  onRevealTag,
}: TagPickerProps) {
  const { t } = useTranslation("files");
  const listTags = useGitStore((state) => state.listTags);
  const listRemoteTags = useGitStore((state) => state.listRemoteTags);
  const createTag = useGitStore((state) => state.createTag);
  const deleteTag = useGitStore((state) => state.deleteTag);
  const deleteRemoteTag = useGitStore((state) => state.deleteRemoteTag);
  const inFlightKind = useGitStore((state) => state.sessions.get(workspaceId)?.inFlightOp?.kind);
  const [createRequest, setCreateRequest] = useState<CreateTagRequest | null>(null);
  const [createRef, setCreateRef] = useState("HEAD");
  const [refPickerOpen, setRefPickerOpen] = useState(false);
  const [deleteRequest, setDeleteRequest] = useState<DeleteTagRequest | null>(null);
  const createTagFields = useMemo(() => buildCreateTagFields(), []);
  const createInitialValues = useMemo(
    () => ({
      name: createRequest?.defaultName ?? "",
      message: "",
    }),
    [createRequest?.defaultName],
  );

  const source = useMemo(
    () =>
      createTagPickerSource({
        workspaceId,
        mode,
        selectedRemote,
        listTags,
        listRemoteTags,
        revealTag: (item) => {
          onRevealTag?.(item.tag);
        },
        requestCreate: (defaultName) => {
          setCreateRef("HEAD");
          setCreateRequest({ defaultName });
        },
        requestDelete: (item, target) => {
          setDeleteRequest(deleteRequestFromTarget(item, target));
        },
      }),
    [workspaceId, mode, selectedRemote, listTags, listRemoteTags, onRevealTag],
  );

  async function submitCreateTag(values: FormDialogValues): Promise<void> {
    const created = await createTag(workspaceId, values.name ?? "", {
      ref: createRef,
      message: values.message?.trim() ? values.message : undefined,
    });
    if (!created) return;
    setCreateRequest(null);
    onRequestReopen?.();
  }

  return (
    <>
      <CommandPalette<TagPickItem>
        open={open}
        source={source}
        onClose={onClose}
        footer={mode === "browse" ? "Enter reveal in History" : undefined}
      />
      <FormDialog
        open={createRequest !== null}
        title={t("git.tagPicker.createDialog.title")}
        description={t("git.tagPicker.createDialog.description")}
        fields={createTagFields}
        initialValues={createInitialValues}
        errorClassName="git-destructive-text"
        extraContent={
          <CreateTagRefSelector
            refName={createRef}
            busy={inFlightKind === "createTag"}
            onPickRef={() => setRefPickerOpen(true)}
          />
        }
        submitLabel={t("git.tagPicker.createDialog.submitLabel")}
        busy={inFlightKind === "createTag"}
        onCancel={() => setCreateRequest(null)}
        onSubmit={({ values }) => {
          void submitCreateTag(values);
        }}
      />
      <RefPicker
        workspaceId={workspaceId}
        open={refPickerOpen}
        onClose={() => setRefPickerOpen(false)}
        onSelectRef={(ref) => {
          setCreateRef(ref);
          setRefPickerOpen(false);
        }}
      />
      <TagDeleteConfirmDialog
        request={deleteRequest}
        busy={inFlightKind === "deleteTag" || inFlightKind === "deleteRemoteTag"}
        onCancel={() => setDeleteRequest(null)}
        onConfirm={(request) => {
          void confirmTagDeleteRequest(request, {
            workspaceId,
            deleteTag,
            deleteRemoteTag,
            onDeleted: () => {
              setDeleteRequest(null);
              onRequestReopen?.();
            },
          });
        }}
      />
    </>
  );
}

/**
 * Renders the target-ref row shown above the create-tag fields.
 */
export function CreateTagRefSelector({
  refName,
  busy = false,
  onPickRef,
}: {
  refName: string;
  busy?: boolean;
  onPickRef: () => void;
}) {
  const { t } = useTranslation("files");
  return (
    <div className="rounded-sm border border-border bg-muted p-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-app-label uppercase text-muted-foreground">{t("git.tagPicker.createTagRef.targetRef")}</div>
          <div className="truncate font-mono text-app-ui-sm text-foreground">{refName}</div>
        </div>
        <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={onPickRef}>
          {t("git.tagPicker.createTagRef.atRef")}
        </Button>
      </div>
    </div>
  );
}

/**
 * Dialog for a single local or remote tag deletion target.
 */
function TagDeleteConfirmDialog({
  request,
  busy = false,
  onCancel,
  onConfirm,
}: {
  request: DeleteTagRequest | null;
  busy?: boolean;
  onCancel: () => void;
  onConfirm: (request: DeleteTagRequest) => void;
}) {
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
          {request ? (
            <TagDeleteConfirmContent
              request={request}
              busy={busy}
              onCancel={onCancel}
              onConfirm={() => onConfirm(request)}
            />
          ) : null}
        </RadixAlertDialog.Content>
      </RadixAlertDialog.Portal>
    </RadixAlertDialog.Root>
  );
}

/**
 * Pure delete confirmation content exported for server-rendered scenario tests.
 */
export function TagDeleteConfirmContent({
  request,
  busy = false,
  onCancel,
  onConfirm,
}: {
  request: DeleteTagRequest;
  busy?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation("files");
  const isRemote = request.kind === "remote";
  const targetLabel = isRemote
    ? `${request.remote}/${request.item.tag.name}`
    : request.item.tag.name;

  return (
    <>
      <h2 className="text-app-body-emphasis text-foreground">
        {isRemote
          ? t("git.tagPicker.deleteConfirm.titleRemote", { name: targetLabel })
          : t("git.tagPicker.deleteConfirm.titleLocal", { name: targetLabel })}
      </h2>
      <p className="mt-2 text-app-ui-sm text-muted-foreground">
        {isRemote
          ? t("git.tagPicker.deleteConfirm.descriptionRemote", { name: request.item.tag.name, remote: request.remote })
          : t("git.tagPicker.deleteConfirm.descriptionLocal", { name: request.item.tag.name, sha: request.item.tag.sha.slice(0, 7) })}
      </p>
      <div className="mt-5 flex justify-end gap-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          autoFocus
          disabled={busy}
          onClick={onCancel}
        >
          {t("git.tagPicker.deleteConfirm.cancel")}
        </Button>
        <Button type="button" variant="destructive" size="sm" disabled={busy} onClick={onConfirm}>
          {t("git.tagPicker.deleteConfirm.confirm")}
        </Button>
      </div>
    </>
  );
}

/**
 * Converts a source-level target into dialog state.
 */
function deleteRequestFromTarget(
  item: Extract<TagPickItem, { kind: "tag" }>,
  target: TagDeleteTarget,
): DeleteTagRequest {
  if (target.kind === "remote" && item.scope === "remote") {
    return { kind: "remote", item, remote: target.remote };
  }
  return { kind: "local", item: item as Extract<TagPickItem, { kind: "tag"; scope: "local" }> };
}

interface ConfirmTagDeleteDeps {
  workspaceId: string;
  deleteTag: (workspaceId: string, name: string) => Promise<boolean>;
  deleteRemoteTag: (workspaceId: string, remote: string, name: string) => Promise<boolean>;
  onDeleted: () => void;
}

/**
 * Runs exactly one tag deletion API for the selected dialog target.
 */
export async function confirmTagDeleteRequest(
  request: DeleteTagRequest,
  deps: ConfirmTagDeleteDeps,
): Promise<boolean> {
  const deleted =
    request.kind === "remote"
      ? await deps.deleteRemoteTag(deps.workspaceId, request.remote, request.item.tag.name)
      : await deps.deleteTag(deps.workspaceId, request.item.tag.name);
  if (!deleted) return false;
  deps.onDeleted();
  return true;
}
