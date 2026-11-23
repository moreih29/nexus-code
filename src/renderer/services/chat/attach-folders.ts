import { isUnder } from "../../../shared/fs/relative-path";
import { ipcCallResult } from "../../ipc/client";
import { resolveFilePath } from "./links";

const SLOT_PATH = /^([A-Za-z0-9_-]{1,128})\/(\d{1,9})\/[^/]+$/;

function slashed(path: string): string | null {
  const forward = path.replace(/\\/g, "/").replace(/\/+$/, "");
  if (forward.startsWith("//")) return null;
  return /^[a-z]:\//.test(forward) ? forward[0].toUpperCase() + forward.slice(1) : forward;
}

export async function attachRootOf(workspaceId: string): Promise<string | null> {
  const result = await ipcCallResult("chat", "attachRoot", { workspaceId }).catch(() => null);
  const root = result?.ok ? result.value.root : null;
  return root ? slashed(root) : null;
}

export function attachSlotOf(root: string, workspaceId: string, file: string): string | null {
  const folder = `${root}/${workspaceId}/`;
  if (!file.startsWith(folder)) return null;
  const match = SLOT_PATH.exec(file.slice(folder.length));
  if (!match) return null;
  return `${match[1]}/${match[2]}`;
}

export function attachShaped(workspaceId: string, file: string): boolean {
  const at = file.lastIndexOf(`/attach/${workspaceId}/`);
  return at >= 0 && attachSlotOf(file.slice(0, at + 7), workspaceId, file) !== null;
}

export function servedAttachment(workspaceId: string, root: string, file: string): boolean {
  return attachShaped(workspaceId, file) || isUnder(file, root);
}

export function attachedOpens(
  gone: ReadonlySet<string>,
  cwd: string,
): (written: string) => boolean {
  return (written) => {
    const file = resolveFilePath(written, cwd);
    return file === null || !gone.has(file);
  };
}
