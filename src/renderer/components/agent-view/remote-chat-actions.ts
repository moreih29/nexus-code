/**
 * What another computer's Claude chat does from its messages, as a chat
 * here's buttons do (chat.rewindPreview, chat.rewind, chat.fork): rewind
 * it to before one of the user's messages, or fork it into a new tab
 * there, which opens here. The message they start from comes back in the
 * composer here, not in that computer's.
 */

import i18next from "i18next";
import type { IpcResult } from "../../../shared/ipc/result";
import { ipcCallResult } from "../../ipc/client";
import type { ChatController } from "../../services/chat/controller";
import { putPeerDraft } from "../../services/remote/peer-drafts";
import { type RemoteTarget, useRemoteViewStore } from "../../state/stores/remote-view";
import { showToast } from "../ui/toast";

async function answerOf<T>(sent: Promise<IpcResult<T>>): Promise<T> {
  const result = await sent;
  if (!result.ok) throw new Error(result.message);
  return result.value;
}

type Chat = Pick<RemoteTarget, "deviceId" | "workspaceId" | "tabId">;

/** The rewind dialog's controller for that chat: a message's key is its id here. */
export function peerRewinder(chat: Chat): Pick<ChatController, "previewRewind" | "rewind"> {
  const ref = { deviceId: chat.deviceId, workspaceId: chat.workspaceId, tabId: chat.tabId };
  return {
    previewRewind: (itemKey) =>
      answerOf(ipcCallResult("remote", "peerChatRewindPreview", { ...ref, itemKey })),
    async rewind(item, { files }) {
      await answerOf(
        ipcCallResult("remote", "peerChatRewind", {
          ...ref,
          itemKey: item.uuid ?? item.key,
          files,
        }),
      );
      if (item.text) putPeerDraft(ref, item.text);
    },
  };
}

/**
 * Forks that chat into a new tab there, from a message (by its key) or
 * all of it, and shows the new tab here in this one's place, as a fork
 * here opens.
 */
export async function forkPeerChat(target: RemoteTarget, itemKey?: string): Promise<void> {
  const ref = { deviceId: target.deviceId, workspaceId: target.workspaceId, tabId: target.tabId };
  try {
    const forked = await answerOf(
      ipcCallResult("remote", "peerChatFork", { ...ref, ...(itemKey ? { itemKey } : {}) }),
    );
    if (forked.draft) putPeerDraft({ ...ref, tabId: forked.tabId }, forked.draft);
    useRemoteViewStore.getState().open({ ...target, tabId: forked.tabId, state: "idle" });
  } catch (error) {
    showToast({
      kind: "error",
      message: i18next.t("agentView.remote.failed", { message: (error as Error).message }),
    });
  }
}
