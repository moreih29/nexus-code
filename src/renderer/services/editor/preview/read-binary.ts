// Reading a workspace file's bytes whole, for the previews that draw a
// zipped format themselves (spreadsheets, documents, presentations), which
// need the whole zip. It goes through the workspace, so local and SSH
// workspaces read the same.

import { MAX_READABLE_FILE_SIZE } from "../../../../shared/fs/defaults";
import { ipcCallResult } from "../../../ipc/client";
import { bytesFromBase64 } from "../encoding/text-encoding";

export type BinaryRead =
  | { readonly kind: "ok"; readonly bytes: Uint8Array }
  /** Over the readable file size limit, so not read. */
  | { readonly kind: "too_large" }
  | { readonly kind: "failed" };

/** The bytes of `relPath`, within the readable file size limit. */
export async function readWorkspaceBinary(
  workspaceId: string,
  relPath: string,
): Promise<BinaryRead> {
  const stat = await ipcCallResult("fs", "stat", { workspaceId, relPath });
  if (stat.ok && stat.value.size > MAX_READABLE_FILE_SIZE) return { kind: "too_large" };
  const read = await ipcCallResult("fs", "readBinary", { workspaceId, relPath });
  if (!read.ok || read.value.kind !== "ok") return { kind: "failed" };
  return { kind: "ok", bytes: bytesFromBase64(read.value.base64) };
}
