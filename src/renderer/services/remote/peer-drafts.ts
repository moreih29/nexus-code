/**
 * What goes back in the composer of another computer's chat here: the
 * message a rewind or fork there started from. That computer's own
 * composer is left as it was; the user who asked goes on with it here.
 */

import { create } from "zustand";
import type { ComposerDraft } from "../chat/store";

/** The chat, by the device it runs on and its tab there. */
interface PeerChat {
  deviceId: string;
  workspaceId: string;
  tabId: string;
}

const keyOf = ({ deviceId, workspaceId, tabId }: PeerChat) => `${deviceId}:${workspaceId}:${tabId}`;

const usePeerDrafts = create<{ drafts: Readonly<Record<string, ComposerDraft>> }>(() => ({
  drafts: {},
}));

/** Puts text in the chat's composer here, after what is typed there. */
export function putPeerDraft(chat: PeerChat, text: string): void {
  usePeerDrafts.setState((s) => ({
    drafts: { ...s.drafts, [keyOf(chat)]: { text, images: [], nonce: Date.now() } },
  }));
}

/** The composer took it. */
export function clearPeerDraft(chat: PeerChat): void {
  const key = keyOf(chat);
  if (!(key in usePeerDrafts.getState().drafts)) return;
  usePeerDrafts.setState((s) => {
    const { [key]: _taken, ...rest } = s.drafts;
    return { drafts: rest };
  });
}

/** What waits for the chat's composer here; none when nothing does. */
export function usePeerDraft(chat: PeerChat): ComposerDraft | undefined {
  return usePeerDrafts((s) => s.drafts[keyOf(chat)]);
}
