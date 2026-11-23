import { useMemo } from "react";
import { ipcCallResult, unwrapIpcResult } from "../../ipc/client";
import { configShownOf } from "../../services/remote/chat-config";
import type { PeerChatRef } from "../../services/remote/peer-mcp";
import { CodexDefaultsDialog, type CodexDefaultsSource } from "../chat/codex-config-dialog";
import { ConfigDialogView, type ConfigSource } from "../chat/config-dialog";

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

export function peerCodexDefaults(ref: PeerChatRef): CodexDefaultsSource {
  return {
    async readDefaults() {
      const { config } = unwrapIpcResult(
        await ipcCallResult("remote", "peerChatConfig", { ...ref }),
      );
      if (!config) throw new Error("it did not tell its defaults");
      return config;
    },
    async saveDefaults(set) {
      unwrapIpcResult(await ipcCallResult("remote", "peerChatConfig", { ...ref, set }));
    },
  };
}

export function RemoteCodexConfigDialog({
  chat,
  open,
  onClose,
}: {
  chat: PeerChatRef;
  open: boolean;
  onClose: () => void;
}) {
  const { deviceId, workspaceId, tabId } = chat;
  const source = useMemo(
    () => peerCodexDefaults({ deviceId, workspaceId, tabId }),
    [deviceId, workspaceId, tabId],
  );
  return <CodexDefaultsDialog source={source} open={open} onClose={onClose} />;
}
