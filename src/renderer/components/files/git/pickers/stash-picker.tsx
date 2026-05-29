/**
 * StashPicker hosts the stash quick-pick.
 *
 * In "apply" mode (default) the picker applies the selected stash.
 * In "drop" mode the picker collects the target stash, then shows a
 * ConfirmDiscardDialog before dropping — matching the BranchPicker
 * delete-local confirm-dialog pattern.
 */
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useGitStore } from "../../../../state/stores/git";
import { CommandPalette } from "../../../ui/palette/command-palette";
import {
  ConfirmDiscardDialog,
  type DiscardConfirmRequest,
} from "../dialogs/confirm-discard-dialog";
import {
  createStashPickerSource,
  type StashPickerMode,
  type StashPickItem,
} from "./stash-picker-source";

interface StashPickerProps {
  workspaceId: string;
  open: boolean;
  onClose: () => void;
  mode?: StashPickerMode;
}

export function StashPicker({ workspaceId, open, onClose, mode = "apply" }: StashPickerProps) {
  const { t } = useTranslation("files");
  const listStashes = useGitStore((state) => state.listStashes);
  const applyStash = useGitStore((state) => state.stashApply);
  const dropStash = useGitStore((state) => state.stashDrop);
  const inFlightKind = useGitStore((state) => state.sessions.get(workspaceId)?.inFlightOp?.kind);

  const [dropRequest, setDropRequest] = useState<DiscardConfirmRequest | null>(null);

  const source = useMemo(
    () =>
      createStashPickerSource({
        workspaceId,
        mode,
        listStashes,
        applyStash,
        requestDrop: (item) => {
          const ref = `stash@{${item.stash.index}}`;
          setDropRequest({
            relPaths: [],
            title: t("git.stashPicker.dropConfirmTitle", { ref }),
            description: t("git.stashPicker.dropConfirmDescription", { ref }),
            confirmLabel: t("git.stashPicker.dropConfirmLabel"),
          });
        },
      }),
    [workspaceId, mode, listStashes, applyStash],
  );

  const footer = mode === "drop" ? t("git.stashPicker.footerDrop") : t("git.stashPicker.footerApply");

  return (
    <>
      <CommandPalette<StashPickItem>
        open={open}
        source={source}
        onClose={onClose}
        footer={footer}
      />
      <ConfirmDiscardDialog
        request={dropRequest}
        busy={inFlightKind === "stashDrop"}
        onCancel={() => setDropRequest(null)}
        onConfirm={(request) => {
          // Extract stash index from title, e.g. "Drop stash@{2}?"
          const match = /stash@\{(\d+)\}/.exec(request.title);
          const index = match ? parseInt(match[1], 10) : 0;
          setDropRequest(null);
          onClose();
          void dropStash(workspaceId, index);
        }}
      />
    </>
  );
}
