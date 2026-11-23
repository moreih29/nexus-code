// Where the agent writes the files attached to a tab's message
// (internal/chat/attach.go): <attach root>/<workspaceId>/<tabId>/<n>/<name>,
// the root on the workspace's host as its agent tells it (through main).
// They stay after the tab closes, for its conversation to go on in another
// tab, which names the same paths. Another device reads a message's
// attachments outside the workspace only from there: a mention in a
// message is text, which anyone who sends one writes as they like.

import { ipcCallResult } from "../../ipc/client";
import { isUnder, resolveFilePath } from "./links";

/**
 * A slot's file below the workspace's folder: `<tabId>/<n>/<name>`, as the
 * agent names slots (internal/chat/attach_retain.go slotDir): a tab of at
 * most 128 letters, digits, "_" or "-", and at most 9 digits. A longer name
 * would not pass as a slot in a call (IPC caps each at 300).
 */
const SLOT_PATH = /^([A-Za-z0-9_-]{1,128})\/(\d{1,9})\/[^/]+$/;

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
 * The slot ("<tabId>/<n>") of `file` (absolute, as resolveFilePath gives
 * it) when it is one the agent wrote for a message of any of the
 * workspace's tabs: right in a numbered folder of a tab's folder under
 * `root` (attachRootOf). Null for any other file.
 */
export function attachSlotOf(root: string, workspaceId: string, file: string): string | null {
  const folder = `${root}/${workspaceId}/`;
  if (!file.startsWith(folder)) return null;
  const match = SLOT_PATH.exec(file.slice(folder.length));
  if (!match) return null;
  return `${match[1]}/${match[2]}`;
}

/**
 * Whether `file` is where the agent writes the workspace's attached files,
 * under whatever root: `…/attach/<workspaceId>/<tabId>/<n>/<name>`, of any
 * tab, as a conversation gone on in another tab names the first one's.
 * What another computer's tab tells that computer serves by, not knowing
 * the root there.
 */
export function attachShaped(workspaceId: string, file: string): boolean {
  const at = file.lastIndexOf(`/attach/${workspaceId}/`);
  return at >= 0 && attachSlotOf(file.slice(0, at + 7), workspaceId, file) !== null;
}

/**
 * Whether another computer serves a file attached to its tab's message
 * (absolute, as resolveFilePath gives it): one its agent wrote for a
 * message (attachShaped), or one in its workspace (`root`). Not one the user
 * attached there from where it was, as from Finder: that stays its own.
 */
export function servedAttachment(workspaceId: string, root: string, file: string): boolean {
  return attachShaped(workspaceId, file) || isUnder(file, root);
}

/**
 * What a chat here answers opensAttached with: every attached file but
 * those `gone` (useGoneFiles), as the agent removes attached files no
 * longer in use, or those of a deleted conversation. A file written from
 * `cwd`.
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
