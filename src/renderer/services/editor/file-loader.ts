// File content loading and external-change reconciliation.
// Owns readFile via fs IPC, encoding detection, and fs.changed event-driven reload.

import type { FileContent, FsChangedEvent } from "../../../shared/types/fs";
import { ipcCall, ipcListen } from "../../ipc/client";
import { absPathToRel } from "../../state/stores/files/helpers";
import { useWorkspacesStore } from "../../state/stores/workspaces";
import type { EditorInput } from "./types";

export type FileLoadResult = FileContent;

export interface FsChangedForFile {
  event: FsChangedEvent;
  relPath: string;
}

export function relPathForInput(input: EditorInput): string {
  const workspace = useWorkspacesStore
    .getState()
    .workspaces.find((candidate) => candidate.id === input.workspaceId);

  if (!workspace) {
    throw new Error(`WORKSPACE_NOT_FOUND: ${input.workspaceId}`);
  }

  return absPathToRel(input.filePath, workspace.rootPath);
}

export async function readFileForModel(input: EditorInput): Promise<FileLoadResult> {
  const relPath = relPathForInput(input);
  return ipcCall("fs", "readFile", { workspaceId: input.workspaceId, relPath });
}

export function subscribeFsChanged(
  input: EditorInput,
  onChange: (change: FsChangedForFile) => void,
): () => void {
  let relPath: string;
  try {
    relPath = relPathForInput(input);
  } catch {
    return () => {};
  }

  return ipcListen("fs", "changed", (event) => {
    if (event.workspaceId !== input.workspaceId) return;
    if (!event.changes.some((change) => change.relPath === relPath)) return;
    onChange({ event, relPath });
  });
}
