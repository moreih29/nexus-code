import i18next from "i18next";
import { FS_ERROR, fsErrorMessage } from "../../../../shared/fs/errors";
import type { FileContent, FsChangedEvent } from "../../../../shared/fs/types";
import { workspaceUriFor } from "../../../../shared/fs/workspace-uri";
import { ipcCallResult, ipcListen, unwrapIpcResult } from "../../../ipc/client";
import { useWorkspacesStore } from "../../../state/stores/workspaces";
import { registerWorkspaceCleanup } from "../../../state/workspace-cleanup";
import { relPath } from "../../../utils/path";
import {
  bytesFromBase64,
  decodeBytes,
  encodingsToTry,
  guessEncoding,
  type TextEncoding,
} from "../encoding/text-encoding";
import type { EditorInput } from "../types";

export type FileLoadResult = Omit<FileContent, "encoding" | "bytes"> & { encoding: TextEncoding };

const encodingOverrides = new Map<string, Map<string, TextEncoding>>();

registerWorkspaceCleanup((workspaceId) => {
  encodingOverrides.delete(workspaceId);
});

function overrideKey(input: EditorInput): string {
  return workspaceUriFor(input.workspaceId, input.filePath);
}

export function setEncodingOverride(input: EditorInput, encoding: TextEncoding): void {
  const { workspaceId } = input;
  if (!useWorkspacesStore.getState().workspaces.some((workspace) => workspace.id === workspaceId)) {
    return;
  }
  const key = overrideKey(input);
  const overrides = encodingOverrides.get(workspaceId) ?? new Map<string, TextEncoding>();
  overrides.set(key, encoding);
  encodingOverrides.set(workspaceId, overrides);
}

function userLanguages(): string[] {
  const languages = [i18next.language];
  if (typeof navigator !== "undefined") languages.push(...(navigator.languages ?? []));
  return languages.filter(Boolean);
}

export function decodeFileContent(result: FileContent, override?: TextEncoding): FileLoadResult {
  const { bytes: base64, encoding, ...rest } = result;
  if (encoding !== "bytes" && override === undefined) return { ...rest, encoding };
  const bytes =
    encoding === "bytes"
      ? bytesFromBase64(base64 ?? "")
      : new TextEncoder().encode(encoding === "utf8-bom" ? `\ufeff${rest.content}` : rest.content);
  const chosen = override ?? guessEncoding(bytes, encodingsToTry(userLanguages()));
  return { ...rest, content: decodeBytes(bytes, chosen), encoding: chosen };
}

export interface FsChangedForFile {
  event: FsChangedEvent;
  relPath: string;
}

export function workspaceRootForInput(input: EditorInput): string {
  const workspace = useWorkspacesStore
    .getState()
    .workspaces.find((candidate) => candidate.id === input.workspaceId);

  if (!workspace) {
    throw new Error(`WORKSPACE_NOT_FOUND: ${input.workspaceId}`);
  }

  return workspace.rootPath;
}

export function relPathForInput(input: EditorInput): string {
  return relPath(input.filePath, workspaceRootForInput(input));
}

export async function readFileForModel(
  input: EditorInput,
  encoding = encodingOverrides.get(input.workspaceId)?.get(overrideKey(input)),
): Promise<FileLoadResult> {
  const rp = relPathForInput(input);
  const result = unwrapIpcResult(
    await ipcCallResult("fs", "readFile", { workspaceId: input.workspaceId, relPath: rp }),
  );
  if (result.kind === "missing") {
    throw new Error(fsErrorMessage(FS_ERROR.NOT_FOUND, input.filePath));
  }
  const { kind: _kind, ...content } = result;
  return decodeFileContent(content, encoding);
}

export async function statFileForModel(
  input: EditorInput,
): Promise<{ mtime: string; size: number }> {
  const rp = relPathForInput(input);
  const stat = unwrapIpcResult(
    await ipcCallResult("fs", "stat", {
      workspaceId: input.workspaceId,
      relPath: rp,
      followSymlink: true,
    }),
  );
  return { mtime: stat.mtime, size: stat.size };
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

export function subscribeGitStatusChanged(input: EditorInput, onChanged: () => void): () => void {
  return ipcListen("git", "statusChanged", (event) => {
    if (event.workspaceId !== input.workspaceId) return;
    onChanged();
  });
}
