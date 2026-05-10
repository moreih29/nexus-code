/**
 * StashPicker hosts the stash quick-pick plus its destructive drop confirm.
 */
import { useMemo, useState } from "react";
import { useGitStore } from "../../../state/stores/git";
import { CommandPalette } from "../../ui/palette/command-palette";
import { ConfirmDiscardDialog, type DiscardConfirmRequest } from "./confirmDiscardDialog";
import { createStashPickerSource, type StashPickItem } from "./stash-picker-source";

interface StashPickerProps {
  workspaceId: string;
  open: boolean;
  onClose: () => void;
  onRequestReopen?: () => void;
}

interface DropRequest {
  item: StashPickItem;
  dialog: DiscardConfirmRequest;
}

export function StashPicker({ workspaceId, open, onClose, onRequestReopen }: StashPickerProps) {
  const listStashes = useGitStore((state) => state.listStashes);
  const applyStash = useGitStore((state) => state.stashApply);
  const dropStash = useGitStore((state) => state.stashDrop);
  const inFlightOp = useGitStore((state) => state.sessions.get(workspaceId)?.inFlightOp);
  const [dropRequest, setDropRequest] = useState<DropRequest | null>(null);

  const source = useMemo(
    () =>
      createStashPickerSource({
        workspaceId,
        listStashes,
        applyStash,
        dropStash,
        confirmDrop: (item) => {
          setDropRequest({
            item,
            dialog: {
              title: "Drop stash?",
              description: `Drop stash@{${item.stash.index}} "${item.stash.message}"? This cannot be undone.`,
              relPaths: [],
              confirmLabel: "Drop",
            },
          });
        },
      }),
    [workspaceId, listStashes, applyStash, dropStash],
  );

  return (
    <>
      <CommandPalette<StashPickItem>
        open={open}
        source={source}
        onClose={onClose}
        footer="Enter apply · Cmd/Ctrl+Enter pop · Cmd/Ctrl+Backspace drop"
      />
      <ConfirmDiscardDialog
        request={dropRequest?.dialog ?? null}
        busy={inFlightOp?.kind === "stashDrop"}
        onCancel={() => setDropRequest(null)}
        onConfirm={async () => {
          const request = dropRequest;
          if (!request) return;
          setDropRequest(null);
          const dropped = await dropStash(workspaceId, request.item.stash.index);
          if (dropped) {
            onRequestReopen?.();
          }
        }}
      />
    </>
  );
}
