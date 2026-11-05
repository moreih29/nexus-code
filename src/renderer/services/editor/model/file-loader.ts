// File content loading and external-change reconciliation.
// Owns readFile via fs IPC, encoding detection, and fs.changed event-driven reload.

import i18next from "i18next";
import { FS_ERROR, fsErrorMessage } from "../../../../shared/fs/errors";
import { workspaceUriFor } from "../../../../shared/fs/workspace-uri";
import type { FileContent, FsChangedEvent } from "../../../../shared/fs/types";
import { ipcCallResult, ipcListen, unwrapIpcResult } from "../../../ipc/client";
import { useWorkspacesStore } from "../../../state/stores/workspaces";
import { relPath } from "../../../utils/path";
import {
  bytesFromBase64,
  decodeBytes,
  encodingsToTry,
  guessEncoding,
  type TextEncoding,
} from "../encoding/text-encoding";
import type { EditorInput } from "../types";

/** A file's text, decoded, and the encoding it was read in. */
export type FileLoadResult = Omit<FileContent, "encoding" | "bytes"> & { encoding: TextEncoding };

/** The encoding each file was reopened or saved in, by its cache URI, while the app runs. */
const encodingOverrides = new Map<string, TextEncoding>();

function overrideKey(input: EditorInput): string {
  return workspaceUriFor(input.workspaceId, input.filePath);
}

/** Reads `input` in `encoding` from now on, as Reopen with Encoding asks. */
export function setEncodingOverride(input: EditorInput, encoding: TextEncoding): void {
  encodingOverrides.set(overrideKey(input), encoding);
}

/** The user's languages, the app's first, for guessing an encoding. */
function userLanguages(): string[] {
  const languages = [i18next.language];
  if (typeof navigator !== "undefined") languages.push(...(navigator.languages ?? []));
  return languages.filter(Boolean);
}

/**
 * The text of a read: as the agent sent it for UTF-8, or decoded from its
 * bytes for any other encoding, the one the file was reopened in when it
 * was, else the one its bytes most likely are in.
 */
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

export async function readFileForModel(input: EditorInput): Promise<FileLoadResult> {
  const rp = relPathForInput(input);
  const result = unwrapIpcResult(
    await ipcCallResult("fs", "readFile", { workspaceId: input.workspaceId, relPath: rp }),
  );
  if (result.kind === "missing") {
    throw new Error(fsErrorMessage(FS_ERROR.NOT_FOUND, input.filePath));
  }
  const { kind: _kind, ...content } = result;
  return decodeFileContent(content, encodingOverrides.get(overrideKey(input)));
}

/** mtime/size only — cheap probe for "did this file change since we loaded it". */
export async function statFileForModel(
  input: EditorInput,
): Promise<{ mtime: string; size: number }> {
  const rp = relPathForInput(input);
  const stat = unwrapIpcResult(
    await ipcCallResult("fs", "stat", { workspaceId: input.workspaceId, relPath: rp }),
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

/**
 * Subscribes to `git.statusChanged` broadcasts for the entry's workspace.
 * Called after a workflow mutation (merge/rebase/cherry-pick) completes and
 * the main process has re-broadcast git status. Returns an unsubscribe fn.
 */
export function subscribeGitStatusChanged(
  input: EditorInput,
  onChanged: () => void,
): () => void {
  return ipcListen("git", "statusChanged", (event) => {
    if (event.workspaceId !== input.workspaceId) return;
    onChanged();
  });
}
