import { useCallback, useEffect, useRef, useState } from "react";
import { ipcCallResult, unwrapIpcResult } from "../../ipc/client";

export interface PeerChatRef {
  readonly deviceId: string;
  readonly workspaceId: string;
  readonly tabId: string;
}

export interface PeerMcpSignIn {
  readonly server: string;
  readonly authUrl: string;
  readonly callbackId: string;
}

export interface PeerMcp {
  readonly signIn: PeerMcpSignIn | null;
  reconnect(server: string): Promise<void>;
  toggle(server: string, enabled: boolean): Promise<void>;
  authenticate(server: string): Promise<void>;
  reopen(): void;
  cancel(): void;
}

function openSignInPage(url: string): void {
  if (/^https?:\/\//i.test(url)) window.open(url, "_blank", "noopener,noreferrer");
}

export function usePeerMcp(ref: PeerChatRef): PeerMcp {
  const { deviceId, workspaceId, tabId } = ref;
  const [signIn, setSignIn] = useState<PeerMcpSignIn | null>(null);
  const current = useRef<PeerMcpSignIn | null>(null);
  current.current = signIn;

  const call = useCallback(
    async (
      server: string,
      action: "reconnect" | "enable" | "disable" | "signIn" | "signedIn",
      extra: { redirectUri?: string; callbackUrl?: string } = {},
    ) =>
      unwrapIpcResult(
        await ipcCallResult("remote", "peerChatMcp", {
          deviceId,
          workspaceId,
          tabId,
          server,
          action,
          ...extra,
        }),
      ),
    [deviceId, workspaceId, tabId],
  );

  const cancel = useCallback(() => {
    const now = current.current;
    if (!now) return;
    void ipcCallResult("chat", "oauthCancel", { id: now.callbackId });
    setSignIn(null);
  }, []);

  useEffect(
    () => () => {
      const now = current.current;
      if (now) void ipcCallResult("chat", "oauthCancel", { id: now.callbackId });
    },
    [],
  );

  const authenticate = useCallback(
    async (server: string) => {
      cancel();
      const { id, redirectUri } = unwrapIpcResult(await ipcCallResult("chat", "oauthListen", {}));
      try {
        const page = await call(server, "signIn", { redirectUri });
        if (!page.authUrl) {
          void ipcCallResult("chat", "oauthCancel", { id });
          return;
        }
        if (!page.back) {
          void ipcCallResult("chat", "oauthCancel", { id });
          openSignInPage(page.authUrl);
          return;
        }
        const back = ipcCallResult("chat", "oauthWait", { id });
        setSignIn({ server, authUrl: page.authUrl, callbackId: id });
        openSignInPage(page.authUrl);
        const url = unwrapIpcResult(await back).url;
        if (url === null) return;
        await call(server, "signedIn", { callbackUrl: url });
      } catch (err) {
        void ipcCallResult("chat", "oauthCancel", { id });
        throw err;
      } finally {
        setSignIn((prev) => (prev?.callbackId === id ? null : prev));
      }
    },
    [call, cancel],
  );

  return {
    signIn,
    reconnect: async (server) => {
      await call(server, "reconnect");
    },
    toggle: async (server, enabled) => {
      await call(server, enabled ? "enable" : "disable");
    },
    authenticate,
    reopen: () => {
      if (current.current) openSignInPage(current.current.authUrl);
    },
    cancel,
  };
}
