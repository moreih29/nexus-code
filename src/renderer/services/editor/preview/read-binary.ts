// Reading a workspace file's bytes whole, for the previews that draw a
// binary format themselves (PDF, spreadsheets). It goes through the
// workspace, so local and SSH workspaces read the same.

import { MAX_READABLE_FILE_SIZE } from "../../../../shared/fs/defaults";
import { ipcCallResult } from "../../../ipc/client";

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

/** Bytes from base64, as fs.readBinary gives a file. */
export function bytesFromBase64(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
