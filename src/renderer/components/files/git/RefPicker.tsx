/**
 * RefPicker — command-palette shell for git.ref-picker.
 */
import { useMemo } from "react";
import { useGitStore } from "../../../state/stores/git";
import { CommandPalette } from "../../ui/palette/command-palette";
import { createRefPickerSource, type RefPickItem } from "./ref-picker-source";

interface RefPickerProps {
  workspaceId: string;
  open: boolean;
  onClose: () => void;
  onSelectRef: (ref: string) => void;
}

export function RefPicker({ workspaceId, open, onClose, onSelectRef }: RefPickerProps) {
  const listBranches = useGitStore((state) => state.listBranches);
  const listTags = useGitStore((state) => state.listTags);
  const listRecentCommits = useGitStore((state) => state.listRecentCommits);

  const source = useMemo(
    () =>
      createRefPickerSource({
        workspaceId,
        listBranches,
        listTags,
        listRecentCommits,
        acceptRef: (ref) => onSelectRef(ref),
      }),
    [workspaceId, listBranches, listTags, listRecentCommits, onSelectRef],
  );

  return (
    <CommandPalette<RefPickItem>
      open={open}
      source={source}
      onClose={onClose}
      footer="Enter select ref · Branches, tags, and recent commits"
    />
  );
}
