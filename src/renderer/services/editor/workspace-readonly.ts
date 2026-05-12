import { useWorkspacesStore } from "../../state/stores/workspaces";
import type { EditorInput } from "./types";

function workspaceIsSsh(workspaceId: string): boolean {
  const workspace = useWorkspacesStore
    .getState()
    .workspaces.find((candidate) => candidate.id === workspaceId);
  return workspace?.location.kind === "ssh";
}

export function isEditorInputReadOnly(input: EditorInput): boolean {
  return input.readOnly === true || workspaceIsSsh(input.workspaceId);
}

export function withWorkspaceReadOnly(input: EditorInput): EditorInput {
  if (!isEditorInputReadOnly(input) || input.readOnly === true) {
    return input;
  }
  return { ...input, readOnly: true };
}
