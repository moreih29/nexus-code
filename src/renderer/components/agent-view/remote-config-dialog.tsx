/**
 * Another computer's Claude chat's settings (/config), in the dialog a tab
 * here has: read from that computer as its own dialog reads them, and the
 * changes saved there as it saves them (chat.config), where it lets this
 * one control its chats.
 */

import { useMemo } from "react";
import { ipcCallResult, unwrapIpcResult } from "../../ipc/client";
import { configShownOf } from "../../services/remote/chat-config";
import type { PeerChatRef } from "../../services/remote/peer-mcp";
import { ConfigDialogView, type ConfigSource } from "../chat/config-dialog";

/** The settings of another computer's chat, as the dialog reads and saves them. */
export function peerConfigSource(ref: PeerChatRef): ConfigSource {
  return {
    load(show, fail) {
      let live = true;
      void ipcCallResult("remote", "peerChatConfig", { ...ref }).then((result) => {
        if (!live) return;
        if (!result.ok) fail(result.message);
        else if (result.value.config) show(configShownOf(result.value.config));
        else fail("it did not tell its settings");
      });
      return () => {
        live = false;
      };
    },
    async apply(changes, _keys, { effort }) {
      // That computer makes the /config messages, with its own keys.
      unwrapIpcResult(
        await ipcCallResult("remote", "peerChatConfig", {
          ...ref,
          set: { changes: { ...changes }, ...(effort ? { effort } : {}) },
        }),
      );
    },
  };
}

export function RemoteConfigDialog({
  chat,
  running,
  open,
  focus,
  onClose,
}: {
  chat: PeerChatRef;
  running: boolean;
  open: boolean;
  focus?: string;
  onClose: () => void;
}) {
  const { deviceId, workspaceId, tabId } = chat;
  const source = useMemo(
    () => peerConfigSource({ deviceId, workspaceId, tabId }),
    [deviceId, workspaceId, tabId],
  );
  return (
    <ConfigDialogView
      source={source}
      running={running}
      open={open}
      focus={focus}
      onClose={onClose}
    />
  );
}
