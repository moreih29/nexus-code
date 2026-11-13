// A session of another computer, shown over the agent view's panels when
// its row under Other computers is picked: a chat drawn by this app's
// message list from what that computer reads of it, which the user writes
// to, answers and stops from here; or a terminal's text, to read only.
// A chat is watched, a terminal read again every moment, while shown.

import { CloudOff, Monitor, Send, Square, X } from "lucide-react";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import type { IpcResult } from "../../../shared/ipc/result";
import { ipcCallResult } from "../../ipc/client";
import type { PermissionAnswer } from "../../services/chat/controller";
import type { PermissionRequest } from "../../services/chat/model";
import { modelOfPage } from "../../services/remote/chat-model";
import { usePeerChat } from "../../services/remote/peer-chat";
import {
  type PeerReach,
  type PeerRead,
  usePeerReach,
  usePeerRead,
} from "../../services/remote/room";
import { type RemoteTarget, useRemoteViewStore } from "../../state/stores/remote-view";
import { cn } from "../../utils/cn";
import { ChatAgentContext } from "../chat/chat-agent";
import { SEND_BUTTON_CLASS } from "../chat/composer";
import { DictationOverlay, MicButton, useComposerDictation } from "../chat/dictation";
import { MessageList } from "../chat/message-list";
import { PermissionCard } from "../chat/permission-card";
import { StatusLine } from "../chat/status-line";
import { IconButton } from "../ui/icon-button";
import { Keycap } from "../ui/keycap";
import { showToast } from "../ui/toast";

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
  const reach = usePeerReach(target.deviceId);
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
        {target.kind === "terminal" && (
          <span className="shrink-0 rounded-(--radius-pill) border border-border px-1.5 text-app-micro text-muted-foreground">
            {t("agentView.remote.viewOnly")}
          </span>
        )}
        <IconButton label={t("agentView.remote.close")} onClick={close}>
          <X aria-hidden className="size-3.5" />
        </IconButton>
      </div>
      {/* Out of reach, nothing in it turns: a running call shows as it was, not as live. */}
      <div
        className={cn(
          "relative flex min-h-0 min-w-0 flex-1 flex-col",
          reach !== "online" && "[&_*]:animate-none!",
        )}
        data-reach={reach}
      >
        {target.kind === "terminal" ? (
          <RemoteTerminal target={target} visible={visible} reach={reach} />
        ) : (
          <RemoteChat target={target} visible={visible} reach={reach} />
        )}
      </div>
    </div>
  );
}

function Waiting({
  read,
  reach,
  device,
}: {
  read: { status: PeerRead<unknown>["status"] };
  reach: PeerReach;
  device: string;
}) {
  const { t } = useTranslation();
  const text =
    reach === "disconnected" && read.status !== "gone"
      ? t("agentView.remote.disconnected")
      : reach === "offline" && read.status !== "gone"
        ? t("agentView.remote.offline", { device })
        : read.status === "loading"
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

/**
 * In place of the controls while the session cannot be reached: what is
 * shown is how it last was, and nothing sent from here would arrive.
 */
export function Unreachable({ reach, device }: { reach: PeerReach; device: string }) {
  const { t } = useTranslation();
  return (
    <div className="shrink-0 px-4 pt-1 pb-3">
      <p
        role="status"
        className="mx-auto flex max-w-[860px] items-center gap-2 rounded-(--radius-raised) border border-border border-dashed px-3 py-2.5 text-app-ui-sm text-muted-foreground"
      >
        <CloudOff aria-hidden className="size-3.5 shrink-0" />
        <span>
          {reach === "disconnected"
            ? t("agentView.remote.disconnectedLast")
            : t("agentView.remote.offlineLast", { device })}
        </span>
      </p>
    </div>
  );
}

/** The protocol's answer for the card's: an always-allow is an allow (the rules stay there). */
export function remoteAnswerOf(answer: PermissionAnswer): {
  decision: "allow" | "deny";
  message?: string;
  updatedInput?: Record<string, unknown>;
  stop?: boolean;
} {
  switch (answer.kind) {
    case "allow":
      return {
        decision: "allow",
        ...(answer.updatedInput ? { updatedInput: answer.updatedInput } : {}),
      };
    case "allow-always":
      return { decision: "allow" };
    case "deny":
      return { decision: "deny", ...(answer.message ? { message: answer.message } : {}) };
    case "deny-stop":
      return {
        decision: "deny",
        stop: true,
        ...(answer.message ? { message: answer.message } : {}),
      };
  }
}

function RemoteChat({
  target,
  visible,
  reach,
}: {
  target: RemoteTarget;
  visible: boolean;
  reach: PeerReach;
}) {
  const { t } = useTranslation();
  const { deviceId, workspaceId, tabId } = target;
  const read = usePeerChat({ deviceId, workspaceId, tabId }, visible);
  const page = read.status === "ready" ? read.value : null;
  const model = useMemo(() => (page ? modelOfPage(page) : null), [page]);
  /** Runs a control; the watch shows what it did, and a refusal is told. */
  const control = async (sent: Promise<IpcResult<unknown>>): Promise<boolean> => {
    const result = await sent;
    if (!result.ok) {
      showToast({
        kind: "error",
        message: t("agentView.remote.failed", { message: result.message }),
      });
    }
    return result.ok;
  };
  const answer = (request: PermissionRequest, given: PermissionAnswer) =>
    void control(
      ipcCallResult("remote", "peerChatAnswer", {
        deviceId,
        workspaceId,
        tabId,
        requestId: request.requestId,
        ...remoteAnswerOf(given),
      }),
    );
  if (read.status !== "ready" || !model) {
    return <Waiting read={read} reach={reach} device={target.deviceName} />;
  }
  return (
    <ChatAgentContext.Provider value={target.kind === "codex" ? "codex" : "claude"}>
      <MessageList
        workspaceId={`remote:${deviceId}`}
        cwd={target.path}
        rootPath={target.path}
        history={null}
        model={model}
      />
      {reach !== "online" ? (
        <Unreachable reach={reach} device={target.deviceName} />
      ) : (
        <>
          {(model.permissions.length > 0 || model.running) && (
            <div className="app-scrollbar max-h-[60%] shrink-0 overflow-y-auto px-4 py-2">
              <div className="mx-auto flex max-w-[860px] flex-col gap-2">
                {model.permissions.length > 0 && (
                  <PermissionCard
                    requests={model.permissions}
                    workspaceId={`remote:${deviceId}`}
                    cwd={target.path}
                    rootPath={target.path}
                    onAnswer={answer}
                  />
                )}
                <StatusLine model={model} />
              </div>
            </div>
          )}
          <RemoteComposer
            device={target.deviceName}
            running={model.running}
            onSend={(text) =>
              control(
                ipcCallResult("remote", "peerChatSend", { deviceId, workspaceId, tabId, text }),
              )
            }
            onStop={() =>
              void control(
                ipcCallResult("remote", "peerChatInterrupt", { deviceId, workspaceId, tabId }),
              )
            }
          />
        </>
      )}
    </ChatAgentContext.Provider>
  );
}

/**
 * Where the user writes to the chat from here: Enter sends, Shift+Enter
 * starts a line; during a turn the message waits for the turn to read it,
 * and the stop button stops the turn.
 */
export function RemoteComposer({
  device,
  running,
  onSend,
  onStop,
}: {
  /** The device the chat runs on, named in the empty box. */
  device: string;
  running: boolean;
  onSend: (text: string) => Promise<boolean>;
  onStop: () => void;
}) {
  const { t } = useTranslation();
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const dictation = useComposerDictation({ text, setText, areaRef });
  const send = async () => {
    const message = text.trim();
    // Never sent while dictating: the text is the user's to read and edit first.
    if (!message || sending || dictation.active) return;
    setSending(true);
    const sent = await onSend(message);
    setSending(false);
    if (sent) setText("");
  };
  const onKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return;
    // Dictating, the box only listens: Escape or Enter stops it, and nothing is sent.
    if (dictation.active) {
      if (event.key === "Escape" || event.key === "Enter") {
        event.preventDefault();
        event.stopPropagation();
        dictation.toggle();
      }
      return;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void send();
    }
  };
  const hasText = text.trim() !== "";
  // Drawn as this app's own composer is, but for what only this device has.
  return (
    <div className="shrink-0 px-4 pt-1 pb-3">
      <div className="mx-auto max-w-[860px] rounded-(--radius-raised) border border-border bg-background focus-within:border-ring">
        <div className="relative">
          <textarea
            ref={areaRef}
            value={text}
            rows={Math.min(8, Math.max(2, text.split("\n").length))}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
            onFocus={dictation.onFocus}
            readOnly={sending || dictation.active}
            placeholder={t("agentView.remote.placeholder", { device })}
            aria-label={t("agentView.remote.placeholder", { device })}
            className={cn(
              "app-scrollbar block w-full resize-none bg-transparent px-3 py-2 text-app-body text-foreground outline-none placeholder:text-muted-foreground",
              dictation.partial && "text-transparent caret-transparent",
            )}
            data-testid="remote-composer"
          />
          {dictation.partial && (
            <DictationOverlay
              text={text}
              partial={dictation.partial}
              areaRef={areaRef}
              className="px-3 py-2 text-app-body"
            />
          )}
        </div>
        <div className="flex items-center justify-end gap-1 px-1.5 pb-1.5">
          <MicButton dictation={dictation} />
          {running && (
            <IconButton label={t("agentView.remote.stop")} size="md" onClick={onStop}>
              <Square aria-hidden className="size-3.5 fill-current" />
            </IconButton>
          )}
          {/* During a turn an empty box offers only stop, as this app's own does. */}
          {(!running || hasText) && (
            <button
              type="button"
              onClick={() => void send()}
              disabled={sending || !hasText || dictation.active}
              aria-label={t("agentView.remote.send")}
              title={t("agentView.remote.send")}
              className={cn(SEND_BUTTON_CLASS, "pr-1.5 pl-2")}
            >
              <Send aria-hidden className="size-4" />
              <Keycap>↵</Keycap>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function RemoteTerminal({
  target,
  visible,
  reach,
}: {
  target: RemoteTarget;
  visible: boolean;
  reach: PeerReach;
}) {
  const { deviceId, workspaceId, tabId } = target;
  const { read } = usePeerRead(
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
  if (text === null) return <Waiting read={read} reach={reach} device={target.deviceName} />;
  return (
    <>
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
      {reach !== "online" && <Unreachable reach={reach} device={target.deviceName} />}
    </>
  );
}
