// Where the agent writes a tab's attached files (internal/chat/attach.go):
// <attach root>/<workspaceId>/<tabId>/<n>/<name>, the root on the
// workspace's host as its agent tells it (through main). Another device reads a message's
// attachments outside the workspace only from there: a mention in a
// message is text, which anyone who sends one writes as they like.

import { ipcCallResult } from "../../ipc/client";
import { isUnder, resolveFilePath } from "./links";

/** A numbered folder's file, below a tab's folder: `<n>/<name>`. */
const SLOT_FILE = /^\d+\/[^/]+$/;

/**
 * A path as resolveFilePath gives one, taken as it is written: "/" for
 * "\", a Windows drive in upper case, no "/" at the end. Nothing in it is
 * read as a link's (no %xx, #, ? or :line). Null for a network path
 * (\\server\share\…), which links never resolve to, on purpose (links.ts):
 * the attachments under a home on a share are not served.
 */
function slashed(path: string): string | null {
  const forward = path.replace(/\\/g, "/").replace(/\/+$/, "");
  if (forward.startsWith("//")) return null;
  return /^[a-z]:\//.test(forward) ? forward[0].toUpperCase() + forward.slice(1) : forward;
}

/** The workspace's attach root, as resolveFilePath writes paths; null when its agent tells none. */
export async function attachRootOf(workspaceId: string): Promise<string | null> {
  const result = await ipcCallResult("chat", "attachRoot", { workspaceId }).catch(() => null);
  const root = result?.ok ? result.value.root : null;
  return root ? slashed(root) : null;
}

/**
 * Whether `file` (absolute, as resolveFilePath gives it) is one the agent
 * wrote for a message of the tab: right in a numbered folder of the tab's
 * folder under `root` (attachRootOf).
 */
export function inAttachFolder(
  root: string,
  workspaceId: string,
  tabId: string,
  file: string,
): boolean {
  const folder = `${root}/${workspaceId}/${tabId}/`;
  return file.startsWith(folder) && SLOT_FILE.test(file.slice(folder.length));
}

/**
 * Whether `file` is where the agent writes the tab's attached files, under
 * whatever root: `…/attach/<workspaceId>/<tabId>/<n>/<name>`. What another
 * computer's tab tells that computer serves by, not knowing the root there.
 */
export function attachShaped(workspaceId: string, tabId: string, file: string): boolean {
  const at = file.lastIndexOf(`/attach/${workspaceId}/${tabId}/`);
  return at >= 0 && inAttachFolder(file.slice(0, at + 7), workspaceId, tabId, file);
}

/**
 * Whether another computer serves a file attached to its tab's message
 * (absolute, as resolveFilePath gives it): one its agent wrote for the tab
 * (attachShaped), or one in its workspace (`root`). Not one the user
 * attached there from where it was, as from Finder: that stays its own.
 */
export function servedAttachment(
  workspaceId: string,
  tabId: string,
  root: string,
  file: string,
): boolean {
  return attachShaped(workspaceId, tabId, file) || isUnder(file, root);
}

/**
 * What a chat here answers opensAttached with: every attached file but
 * those `gone` (useGoneFiles), as the agent removes a tab's attached files
 * when the tab closes. A file written from `cwd`.
 */
export function attachedOpens(
  gone: ReadonlySet<string>,
  cwd: string,
): (written: string) => boolean {
  return (written) => {
    const file = resolveFilePath(written, cwd);
    return file === null || !gone.has(file);
  };
}
