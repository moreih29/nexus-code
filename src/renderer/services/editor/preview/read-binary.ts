import { MAX_READABLE_FILE_SIZE } from "../../../../shared/fs/defaults";
import { ipcCallResult } from "../../../ipc/client";
import { peerOf, readPeerBinary } from "../../remote/peer-workspace";
import { bytesFromBase64 } from "../encoding/text-encoding";

export type BinaryRead =
  | { readonly kind: "ok"; readonly bytes: Uint8Array }
  | { readonly kind: "too_large" }
  | { readonly kind: "failed" };

export async function readWorkspaceBinary(
  workspaceId: string,
  relPath: string,
  signal?: AbortSignal,
  draft?: File,
): Promise<BinaryRead> {
  if (draft) {
    if (draft.size > MAX_READABLE_FILE_SIZE) return { kind: "too_large" };
    const bytes = new Uint8Array(await draft.arrayBuffer());
    return signal?.aborted ? { kind: "failed" } : { kind: "ok", bytes };
  }
  const peer = peerOf(workspaceId);
  if (peer) return readPeerBinary(peer, relPath, signal);
  const stat = await ipcCallResult("fs", "stat", { workspaceId, relPath });
  if (stat.ok && stat.value.size > MAX_READABLE_FILE_SIZE) return { kind: "too_large" };
  const read = await ipcCallResult("fs", "readBinary", { workspaceId, relPath });
  if (!read.ok || read.value.kind !== "ok") return { kind: "failed" };
  return { kind: "ok", bytes: bytesFromBase64(read.value.base64) };
}
