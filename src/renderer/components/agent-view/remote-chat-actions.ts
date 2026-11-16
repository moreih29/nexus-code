/**
 * What another computer's Claude chat does from its messages, as a chat
 * here's buttons do (chat.rewindPreview, chat.rewind, chat.fork): rewind
 * it to before one of the user's messages, or fork it into a new tab
 * there, which opens here. The message they start from comes back in the
 * composer here, not in that computer's, with its images (read from that
 * computer before it goes).
 */

import i18next from "i18next";
import type { IpcResult } from "../../../shared/ipc/result";
import { ipcCallResult } from "../../ipc/client";
import type { ChatController } from "../../services/chat/controller";
import type { ImageBlock } from "../../services/chat/model";
import { putPeerDraft } from "../../services/remote/peer-drafts";
import { type RemoteTarget, useRemoteViewStore } from "../../state/stores/remote-view";
import { showToast } from "../ui/toast";

async function answerOf<T>(sent: Promise<IpcResult<T>>): Promise<T> {
  const result = await sent;
  if (!result.ok) throw new Error(result.message);
  return result.value;
}

type Chat = Pick<RemoteTarget, "deviceId" | "workspaceId" | "tabId">;

/**
 * A message's images with their bytes, as large as that computer sends one
 * (chat.image); one it cannot send is left out.
 */
export async function draftImagesOf(
  chat: Chat,
  images: readonly ImageBlock[] | undefined,
): Promise<ImageBlock[]> {
  const read = await Promise.all(
    (images ?? []).map(async (image): Promise<ImageBlock | null> => {
      if (image.data) return { mediaType: image.mediaType, data: image.data };
      if (!image.remote) return null;
      const result = await ipcCallResult("remote", "peerChatImage", {
        deviceId: chat.deviceId,
        workspaceId: chat.workspaceId,
        tabId: chat.tabId,
        ref: image.remote,
      });
      return result.ok ? { mediaType: result.value.mediaType, data: result.value.data } : null;
    }),
  );
  return read.filter((image): image is ImageBlock => image !== null);
}

/** The rewind dialog's controller for that chat: a message's key is its id here. */
export function peerRewinder(chat: Chat): Pick<ChatController, "previewRewind" | "rewind"> {
  const ref = { deviceId: chat.deviceId, workspaceId: chat.workspaceId, tabId: chat.tabId };
  return {
    previewRewind: (itemKey) =>
      answerOf(ipcCallResult("remote", "peerChatRewindPreview", { ...ref, itemKey })),
    async rewind(item, { files }) {
      // Read before the rewind takes the message away there.
      const images = await draftImagesOf(ref, item.images);
      await answerOf(
        ipcCallResult("remote", "peerChatRewind", {
          ...ref,
          itemKey: item.uuid ?? item.key,
          files,
        }),
      );
      if (item.text || images.length > 0) putPeerDraft(ref, item.text, images);
    },
  };
}

/**
 * Forks that chat into a new tab there, from a message (by its key) or
 * all of it, and shows the new tab here in this one's place, as a fork
 * here opens.
 */
export async function forkPeerChat(
  target: RemoteTarget,
  itemKey?: string,
  /** The images of the message it forks from, which come back with it. */
  images?: readonly ImageBlock[],
): Promise<void> {
  const ref = { deviceId: target.deviceId, workspaceId: target.workspaceId, tabId: target.tabId };
  try {
    const forked = await answerOf(
      ipcCallResult("remote", "peerChatFork", { ...ref, ...(itemKey ? { itemKey } : {}) }),
    );
    // Only a message of the user's comes back as a draft.
    const drafted = forked.draft !== undefined ? await draftImagesOf(ref, images) : [];
    if (forked.draft || drafted.length > 0) {
      putPeerDraft({ ...ref, tabId: forked.tabId }, forked.draft ?? "", drafted);
    }
    useRemoteViewStore.getState().open({ ...target, tabId: forked.tabId, state: "idle" });
  } catch (error) {
    showToast({
      kind: "error",
      message: i18next.t("agentView.remote.failed", { message: (error as Error).message }),
    });
  }
}
