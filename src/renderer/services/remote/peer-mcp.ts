/**
 * Another computer's chat's MCP servers, worked from this one as a chat's
 * panel here works its own (chat.mcp): connected again, turned on or off,
 * signed in to. A sign-in is this computer's, as for a chat on an SSH
 * host: the page opens in the browser here and comes back to a page on
 * this machine (main's oauth callbacks), whose address goes on to that
 * computer's Claude Code.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { ipcCallResult, unwrapIpcResult } from "../../ipc/client";

/** A chat of another computer's, by where it is there. */
export interface PeerChatRef {
  readonly deviceId: string;
  readonly workspaceId: string;
  readonly tabId: string;
}

/** A sign-in under way: its server, the page it opened, the callback it waits on. */
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
  /** Opens the sign-in page under way again. */
  reopen(): void;
  /** Stops waiting for the sign-in under way. */
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

  // A sign-in left waiting when the chat goes stops waiting.
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
          // Signed in already: that computer connected it again.
          void ipcCallResult("chat", "oauthCancel", { id });
          return;
        }
        if (!page.back) {
          // Nothing comes back here (a claude.ai connector): the page is all.
          void ipcCallResult("chat", "oauthCancel", { id });
          openSignInPage(page.authUrl);
          return;
        }
        // Waiting before the browser opens, so a sign-in that comes straight back is not missed.
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
