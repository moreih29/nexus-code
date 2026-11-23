/**
 * The tab commands in a workspace on another computer, where no local
 * workspace is active: ⌘W closes its front tab, the bulk closes close its
 * tabs, and the tab cycling moves along its strip, as in a local one. ⌘T
 * opens a terminal there only where that computer lets this one control
 * its terminals. The agent view's interceptor takes these first while it
 * is shown.
 */

import { newPeerTerminal } from "../../components/agent-view/remote-session-actions";
import { showPeerWorkspaceSession } from "../../components/peer-workspace/session-placement";
import { ipcCallResult } from "../../ipc/client";
import { peerServes } from "../../services/remote/room";
import { isAgentViewShown } from "../../state/stores/agent-view";
import {
  EMPTY_PEER_VIEW,
  peerTabId,
  peerTargetId,
  usePeerWorkspaceStore,
} from "../../state/stores/peer-workspace";

function shownPeerView() {
  const { active, missing, views } = usePeerWorkspaceStore.getState();
  if (!active || missing || isAgentViewShown()) return null;
  const id = peerTargetId(active);
  const view = views[id] ?? EMPTY_PEER_VIEW;
  return { active, id, view, keys: view.tabs.map(peerTabId) };
}

export type PeerTabCommand = "close" | "closeOthers" | "closeAll" | "next" | "previous";

/** Runs a tab command in the peer workspace shown; false where none is. */
export function runPeerTabCommand(command: PeerTabCommand): boolean {
  const shown = shownPeerView();
  if (!shown) return false;
  const { id, view, keys } = shown;
  const store = usePeerWorkspaceStore.getState();
  const front = view.activePath;
  const close = (closing: readonly string[]) => {
    for (const key of closing) store.closeTab(id, key);
  };
  if (command === "close") {
    if (front !== null) close([front]);
  } else if (command === "closeOthers") {
    close(keys.filter((key) => key !== front));
  } else if (command === "closeAll") {
    close(keys);
  } else if (keys.length > 1) {
    const at = front === null ? -1 : keys.indexOf(front);
    const delta = command === "next" ? 1 : -1;
    const next =
      at < 0 ? (delta === 1 ? 0 : keys.length - 1) : (at + delta + keys.length) % keys.length;
    store.selectTab(id, keys[next] as string);
  }
  return true;
}

/**
 * Opens a terminal in the peer workspace shown, with that computer's
 * default shell, where it lets this one control its terminals; false
 * where no peer workspace is shown.
 */
export function newPeerWorkspaceTerminal(): boolean {
  const shown = shownPeerView();
  if (!shown) return false;
  const { active } = shown;
  void ipcCallResult("remote", "room", undefined).then((room) => {
    if (!room.ok || room.value?.status !== "online") return;
    const peer = room.value.peers.find((each) => each.id === active.deviceId && each.online);
    if (!peerServes(peer, "terminal.control")) return;
    void newPeerTerminal(
      {
        deviceId: active.deviceId,
        deviceName: active.deviceName,
        workspaceId: active.workspaceId,
        workspaceName: active.workspace.name,
        path: active.workspace.path,
      },
      undefined,
      (session) => showPeerWorkspaceSession(active, session),
    );
  });
  return true;
}
