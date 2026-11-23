import { ipcCallResult, unwrapIpcResult } from "@/ipc/client";

export async function listDirNames(workspaceId: string, dirRelPath: string): Promise<Set<string>> {
  const entries = unwrapIpcResult(
    await ipcCallResult("fs", "readdir", { workspaceId, relPath: dirRelPath, includeHidden: true }),
  );
  return new Set(entries.map((e) => e.name));
}
