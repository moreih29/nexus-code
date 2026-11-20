import type { DiffHunk } from "../../../../packages/remote-protocol/src/rpc";
import type { RemoteFileRef } from "../../../shared/fs/remote-file-key";
import { ipcCallResult } from "../../ipc/client";

/**
 * The file before the changes `hunks` tell, from the file as it is now:
 * the hunks of a diff against the last commit taken back. Null when they
 * do not fit the file now (it changed since).
 */
export function beforeOfHunks(hunks: readonly DiffHunk[], now: string): string | null {
  const lines = now.split("\n");
  const out: string[] = [];
  let at = 0;
  for (const hunk of [...hunks].sort((a, b) => a.newStart - b.newStart)) {
    // A hunk that adds nothing starts after its line; any other, at it.
    const from = hunk.newLines === 0 ? hunk.newStart : hunk.newStart - 1;
    if (from < at || from > lines.length) return null;
    out.push(...lines.slice(at, from));
    at = from;
    for (const line of hunk.lines) {
      const mark = line[0];
      const text = line.slice(1);
      if (mark === " ") {
        if (lines[at] !== text) return null;
        out.push(text);
        at++;
      } else if (mark === "-") {
        out.push(text);
      } else if (mark === "+") {
        if (lines[at] !== text) return null;
        at++;
      }
      // "\ No newline at end of file" tells nothing of the lines.
    }
  }
  out.push(...lines.slice(at));
  return out.join("\n");
}

/** The session's saved original, or the last commit when that original is unavailable. */
export async function readRemoteFileBefore(
  file: RemoteFileRef,
  tabId: string,
  signal?: AbortSignal,
): Promise<string | null | undefined> {
  const kept = await ipcCallResult("remote", "peerChatOriginal", { ...file, tabId }, { signal });
  if (kept.ok) return kept.value.before;
  if (signal?.aborted) return undefined;
  const [diff, read] = await Promise.all([
    ipcCallResult("remote", "peerGitDiff", file, { signal }),
    ipcCallResult("remote", "peerFilesRead", file, { signal }),
  ]);
  if (!diff.ok || diff.value.binary || diff.value.hunks.length === 0) return undefined;
  if (!read.ok || read.value.kind !== "text" || read.value.truncated) return undefined;
  return beforeOfHunks(diff.value.hunks, read.value.text) ?? undefined;
}
