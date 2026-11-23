// The folders the agent writes a tab's attached files in, as it answers
// chat.attach: <root>/attach/<workspaceId>/<tabId>, each file in a
// numbered folder of its own there. Another device reads a message's
// attachments outside the workspace only from these: a mention in a
// message is text, which anyone who sends one writes as they like. The
// folders are known from the files written since the app started.

import { ipcCallResult, unwrapIpcResult } from "../../ipc/client";
import { resolveFilePath } from "./links";

/** The tab's folders (one for each root an agent answered with), by tab. */
const folders = new Map<string, Set<string>>();

function keyOf(workspaceId: string, tabId: string): string {
  return `${workspaceId}\0${tabId}`;
}

/** A numbered folder's file, below a tab's folder: `<n>/<name>`. */
const SLOT_FILE = /^\d+\/[^/]+$/;

/**
 * Writes a file attached to a tab's message where its program reads it
 * (on an SSH host, a file from this machine), and returns its path there.
 */
export async function attachFile(
  target: { workspaceId: string; tabId: string },
  name: string,
  data: string,
): Promise<string> {
  const { workspaceId, tabId } = target;
  const result = unwrapIpcResult(
    await ipcCallResult("chat", "attach", { workspaceId, tabId, name, data }),
  );
  noteAttached(workspaceId, tabId, result.path);
  return result.path;
}

/**
 * Keeps the tab's folder that `path` is in, a file the agent wrote for one
 * of its messages: `…/attach/<workspaceId>/<tabId>/<n>/<name>`. A path of
 * another shape names no folder.
 */
export function noteAttached(workspaceId: string, tabId: string, path: string): void {
  const file = resolveFilePath(path, "/");
  if (!file) return;
  const parts = file.split("/");
  const [attach, workspace, tab, slot] = parts.slice(-5, -1);
  if (
    parts.length < 6 ||
    attach !== "attach" ||
    workspace !== workspaceId ||
    tab !== tabId ||
    !/^\d+$/.test(slot ?? "")
  )
    return;
  const key = keyOf(workspaceId, tabId);
  const kept = folders.get(key) ?? new Set<string>();
  kept.add(parts.slice(0, -2).join("/"));
  folders.set(key, kept);
}

/**
 * Whether `file` (absolute, as resolveFilePath gives it) is one the agent
 * wrote for a message of the tab: right in a numbered folder of its folder.
 */
export function inAttachFolder(workspaceId: string, tabId: string, file: string): boolean {
  for (const folder of folders.get(keyOf(workspaceId, tabId)) ?? []) {
    if (file.startsWith(`${folder}/`) && SLOT_FILE.test(file.slice(folder.length + 1))) return true;
  }
  return false;
}

/** Forgets every folder: for tests. */
export function forgetAttachFolders(): void {
  folders.clear();
}
