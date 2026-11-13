// A session of another computer, shown over the agent view's panels when
// its row under Other computers is picked: a chat drawn by this app's
// message list from what that computer reads of it, or a terminal's text.
// Both are read again every moment while shown. Nothing is sent to it yet.

import { Monitor, X } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { ipcCallResult } from "../../ipc/client";
import { modelOfPage } from "../../services/remote/chat-model";
import { type PeerRead, usePeerRead } from "../../services/remote/room";
import { type RemoteTarget, useRemoteViewStore } from "../../state/stores/remote-view";
import { ChatAgentContext } from "../chat/chat-agent";
import { MessageList } from "../chat/message-list";
import { StatusLine } from "../chat/status-line";
import { IconButton } from "../ui/icon-button";

/** How many lines of a terminal are shown. */
const TERMINAL_LINES = 2000;

/**
 * The session shown, over the panels; nothing when none is. It is read
 * only while the agent view is `visible`.
 */
export function RemotePane({ visible }: { visible: boolean }) {
  const shown = useRemoteViewStore((s) => s.shown);
  if (!shown) return null;
  return (
    <RemoteSessionPane key={`${shown.deviceId}/${shown.tabId}`} target={shown} visible={visible} />
  );
}

export function RemoteSessionPane({ target, visible }: { target: RemoteTarget; visible: boolean }) {
  const { t } = useTranslation();
  const close = useRemoteViewStore((s) => s.close);
  useEffect(() => {
    if (!visible) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close, visible]);
  return (
    <div
      className="absolute inset-0 z-30 flex min-h-0 min-w-0 flex-col overflow-hidden rounded-(--radius-island) island-surface"
      data-testid="remote-pane"
    >
      <div className="flex h-9 shrink-0 items-center gap-1.5 px-3">
        <Monitor aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="shrink-0 text-app-ui-sm text-muted-foreground">
          {target.deviceName} · {target.workspaceName}
        </span>
        <span className="min-w-0 flex-1 truncate text-app-ui-sm text-foreground">
          {target.title}
        </span>
        <span className="shrink-0 text-app-micro text-muted-foreground">
          {t("agentView.remote.viewOnly")}
        </span>
        <IconButton label={t("agentView.remote.close")} onClick={close}>
          <X aria-hidden className="size-3.5" />
        </IconButton>
      </div>
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
        {target.kind === "terminal" ? (
          <RemoteTerminal target={target} visible={visible} />
        ) : (
          <RemoteChat target={target} visible={visible} />
        )}
      </div>
    </div>
  );
}

function Waiting({ read }: { read: { status: PeerRead<unknown>["status"] } }) {
  const { t } = useTranslation();
  const text =
    read.status === "loading"
      ? t("agentView.remote.loading")
      : read.status === "gone"
        ? t("agentView.remote.gone")
        : t("agentView.remote.unavailable");
  return (
    <p className="m-auto px-4 text-center text-app-ui-sm text-muted-foreground" role="status">
      {text}
    </p>
  );
}

function RemoteChat({ target, visible }: { target: RemoteTarget; visible: boolean }) {
  const { deviceId, workspaceId, tabId } = target;
  const read = usePeerRead(
    `${deviceId}/${workspaceId}/${tabId}`,
    () => ipcCallResult("remote", "peerChat", { deviceId, workspaceId, tabId }),
    visible,
  );
  const page = read.status === "ready" ? read.value : null;
  const model = useMemo(() => (page ? modelOfPage(page) : null), [page]);
  if (read.status !== "ready" || !model) return <Waiting read={read} />;
  return (
    <ChatAgentContext.Provider value={target.kind === "codex" ? "codex" : "claude"}>
      <MessageList
        workspaceId={`remote:${deviceId}`}
        cwd={target.path}
        rootPath={target.path}
        history={null}
        model={model}
      />
      {model.running && (
        <div className="shrink-0 px-4 py-2">
          <div className="mx-auto max-w-[860px]">
            <StatusLine model={model} />
          </div>
        </div>
      )}
    </ChatAgentContext.Provider>
  );
}

function RemoteTerminal({ target, visible }: { target: RemoteTarget; visible: boolean }) {
  const { deviceId, workspaceId, tabId } = target;
  const read = usePeerRead(
    `${deviceId}/${workspaceId}/${tabId}`,
    () =>
      ipcCallResult("remote", "peerTerminal", {
        deviceId,
        workspaceId,
        tabId,
        lines: TERMINAL_LINES,
      }),
    visible,
  );
  const ref = useRef<HTMLPreElement>(null);
  const text = read.status === "ready" ? read.value.text : null;
  // Kept at the end, as a terminal is, unless the user scrolled up to read.
  const stuck = useRef(true);
  useEffect(() => {
    const el = ref.current;
    if (el && text !== null && stuck.current) el.scrollTop = el.scrollHeight;
  }, [text]);
  if (text === null) return <Waiting read={read} />;
  return (
    <pre
      ref={ref}
      onScroll={(e) => {
        const el = e.currentTarget;
        stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
      }}
      className="app-scrollbar min-h-0 flex-1 overflow-auto px-4 py-2 font-mono text-app-ui-sm whitespace-pre text-foreground"
      data-testid="remote-terminal"
    >
      {text}
    </pre>
  );
}
