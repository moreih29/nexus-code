import i18next from "i18next";
import type { IpcResult } from "../../../shared/ipc/result";
import { ipcCallResult } from "../../ipc/client";
import type { ChatController } from "../../services/chat/claude/controller";
import type { ImageBlock, UserItem } from "../../services/chat/model";
import { putPeerDraft } from "../../services/remote/peer-drafts";
import {
  type OpenRemoteSession,
  openRemoteSession,
  type RemoteTarget,
} from "../../state/stores/remote-view";
import { showToast } from "../ui/toast";

async function answerOf<T>(sent: Promise<IpcResult<T>>): Promise<T> {
  const result = await sent;
  if (!result.ok) throw new Error(result.message);
  return result.value;
}

type Chat = Pick<RemoteTarget, "deviceId" | "workspaceId" | "tabId">;

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
      }).catch(() => null);
      return result?.ok ? { mediaType: result.value.mediaType, data: result.value.data } : null;
    }),
  );
  return read.filter((image): image is ImageBlock => image !== null);
}

export function peerRewinder(chat: Chat): Pick<ChatController, "previewRewind" | "rewind"> {
  const ref = { deviceId: chat.deviceId, workspaceId: chat.workspaceId, tabId: chat.tabId };
  return {
    previewRewind: (itemKey) =>
      answerOf(ipcCallResult("remote", "peerChatRewindPreview", { ...ref, itemKey })),
    async rewind(item, { files }) {
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

export async function forkPeerChat(
  target: RemoteTarget,
  itemKey?: string,
  user?: Pick<UserItem, "text" | "images">,
  open: OpenRemoteSession = openRemoteSession,
): Promise<void> {
  const ref = { deviceId: target.deviceId, workspaceId: target.workspaceId, tabId: target.tabId };
  try {
    const forked = await answerOf(
      ipcCallResult("remote", "peerChatFork", { ...ref, ...(itemKey ? { itemKey } : {}) }),
    );
    const text = forked.draft ?? user?.text;
    const images = user ? await draftImagesOf(ref, user.images) : [];
    if (text || images.length > 0) {
      putPeerDraft({ ...ref, tabId: forked.tabId }, text ?? "", images);
    }
    open({ ...target, tabId: forked.tabId, state: "idle" });
  } catch (error) {
    showToast({
      kind: "error",
      message: i18next.t("agentView.remote.failed", { message: (error as Error).message }),
    });
  }
}
