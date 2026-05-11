/**
 * StashPicker hosts the stash quick-pick.
 */
import { useMemo } from "react";
import { useGitStore } from "../../../state/stores/git";
import { CommandPalette } from "../../ui/palette/command-palette";
import { createStashPickerSource, type StashPickItem } from "./stash-picker-source";

interface StashPickerProps {
  workspaceId: string;
  open: boolean;
  onClose: () => void;
}

export function StashPicker({ workspaceId, open, onClose }: StashPickerProps) {
  const listStashes = useGitStore((state) => state.listStashes);
  const applyStash = useGitStore((state) => state.stashApply);

  const source = useMemo(
    () =>
      createStashPickerSource({
        workspaceId,
        listStashes,
        applyStash,
      }),
    [workspaceId, listStashes, applyStash],
  );

  return (
    <CommandPalette<StashPickItem>
      open={open}
      source={source}
      onClose={onClose}
      footer="Enter apply"
    />
  );
}
