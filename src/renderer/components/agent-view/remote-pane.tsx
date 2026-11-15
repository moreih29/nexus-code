import { CloudOff } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import type { IpcResult } from "../../../shared/ipc/result";
import { ipcCallResult } from "../../ipc/client";
import type { PermissionAnswer } from "../../services/chat/controller";
import type { ChatModel, PermissionRequest } from "../../services/chat/model";
import type { UsageLine, UsageMeter, UsageMeterKind } from "../../services/chat/usage-line";
import { modelOfPage } from "../../services/remote/chat-model";
import { usePeerChat, type WatchedChat } from "../../services/remote/peer-chat";
import { usePeerComposer } from "../../services/remote/peer-composer";
import { usePeerTerminal } from "../../services/remote/peer-terminal";
import {
  type PeerReach,
  type PeerRead,
  usePeerControls,
  usePeerReach,
} from "../../services/remote/room";
import { useChatFontStyle } from "../../state/stores/chat-font";
import type { RemoteTarget } from "../../state/stores/remote-view";
import { cn } from "../../utils/cn";
import { ChatAgentContext } from "../chat/chat-agent";
import { Composer } from "../chat/composer";
import { MessageList } from "../chat/message-list";
import { PermissionCard } from "../chat/permission-card";
import { StatusLine } from "../chat/status-line";
import { UsageLineView } from "../chat/usage-line";
import { showToast } from "../ui/toast";

/** How many lines of a terminal are shown. */
const TERMINAL_LINES = 2000;

/**
 * The session in front of a panel, filling it below the panel's tabs. It
 * is read only while the agent view is `visible`.
 */
export function RemoteSessionPane({ target, visible }: { target: RemoteTarget; visible: boolean }) {
  const reach = usePeerReach(target.deviceId);
  const controls = usePeerControls(target.deviceId);
  return (
    // Out of reach, nothing in it turns: a running call shows as it was, not as live.
    <div
      className={cn(
        "absolute inset-0 flex min-h-0 min-w-0 flex-col overflow-hidden",
        reach !== "online" && "[&_*]:animate-none!",
      )}
      data-testid="remote-pane"
      data-reach={reach}
    >
      {target.kind === "terminal" ? (
        <RemoteTerminal target={target} visible={visible} reach={reach} />
      ) : (
        <RemoteChat target={target} visible={visible} reach={reach} controls={controls} />
      )}
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

/**
 * In place of the controls while the device lets this one only look: the
 * turn's status, and why there is nothing to send with.
 */
function ViewOnly({ model, device }: { model: ChatModel; device: string }) {
  const { t } = useTranslation();
  return (
    <div className="shrink-0 px-4 py-2" data-testid="remote-view-only">
      <div className="mx-auto flex max-w-[860px] flex-col gap-2">
        {(model.permissions.length > 0 || model.running) && <StatusLine model={model} />}
        <p className="rounded-(--radius-raised) border border-border border-dashed px-3 py-2.5 text-app-ui-sm text-muted-foreground">
          {t("agentView.remote.viewOnlyNote", { device })}
        </p>
      </div>
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
  controls,
}: {
  target: RemoteTarget;
  visible: boolean;
  reach: PeerReach;
  /** The device lets this one control its chats; else they are only shown. */
  controls: boolean;
}) {
  const { deviceId, workspaceId, tabId } = target;
  const read = usePeerChat({ deviceId, workspaceId, tabId }, visible);
  const page = read.status === "ready" ? read.value : null;
  const model = useMemo(() => (page ? modelOfPage(page) : null), [page]);
  const fontStyle = useChatFontStyle();
  if (read.status !== "ready" || !page || !model) {
    return <Waiting read={read} reach={reach} device={target.deviceName} />;
  }
  return (
    <ChatAgentContext.Provider value={target.kind === "codex" ? "codex" : "claude"}>
      {/* The chat's font, as this app's own tabs take it. */}
      <div
        className="chat-font relative flex min-h-0 flex-1 flex-col bg-background"
        style={fontStyle}
        data-testid="remote-chat"
      >
        <MessageList
          workspaceId={`remote:${deviceId}`}
          cwd={target.path}
          rootPath={target.path}
          history={null}
          model={model}
        />
        {reach !== "online" ? (
          <Unreachable reach={reach} device={target.deviceName} />
        ) : !controls ? (
          <ViewOnly model={model} device={target.deviceName} />
        ) : (
          <RemoteControls target={target} model={model} page={page} visible={visible} />
        )}
      </div>
    </ChatAgentContext.Provider>
  );
}

/** The plan's meters this app names; a kind a newer device sends is left out. */
const METER_KINDS: ReadonlySet<string> = new Set<UsageMeterKind>([
  "session",
  "weekly",
  "weekly_scoped",
  "window",
]);

/**
 * The line under the composer, as a chat's own: how full its context is, and
 * the plan's usage the device tells (planLimits), but for a window already
 * started over since it told.
 */
export function usageLineOf(panel: WatchedChat["panel"], now = Date.now()): UsageLine | null {
  const context = panel?.context;
  const limits = (panel?.planLimits ?? []).filter(
    (m) => METER_KINDS.has(m.kind) && (m.resetsAt === undefined || m.resetsAt > now),
  ) as UsageMeter[];
  if (!context && limits.length === 0) return null;
  return {
    ...(context
      ? {
          context: {
            percent: Math.round((context.usedTokens / context.maxTokens) * 100),
            used: context.usedTokens,
            max: context.maxTokens,
          },
        }
      : {}),
    // The week's for one model is told on hover, as a chat's own line tells it.
    meters: limits.filter((m) => m.kind !== "weekly_scoped"),
    more: limits.filter((m) => m.kind === "weekly_scoped"),
  };
}

/** What the user answers, stops and writes to the chat with: this app's own card and composer. */
function RemoteControls({
  target,
  model,
  page,
  visible,
}: {
  target: RemoteTarget;
  model: ChatModel;
  page: WatchedChat;
  visible: boolean;
}) {
  const { t } = useTranslation();
  const { deviceId, workspaceId, tabId } = target;
  const onError = useCallback(
    (message: string) =>
      showToast({ kind: "error", message: t("agentView.remote.failed", { message }) }),
    [t],
  );
  const composer = usePeerComposer({
    ref: { deviceId, workspaceId, tabId },
    agent: target.kind === "codex" ? "codex" : "claude",
    model,
    active: visible,
    filesRefused: t("agentView.remote.filesRefused"),
    onError,
  });
  /** Runs a control; the watch shows what it did, and a refusal is told. */
  const control = async (sent: Promise<IpcResult<unknown>>) => {
    const result = await sent;
    if (!result.ok) onError(result.message);
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
  const line = useMemo(() => usageLineOf(page.panel), [page.panel]);
  return (
    <>
      {/* Docked over the composer, so a request is seen wherever the list is scrolled. */}
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
      <Composer
        controller={composer.controller}
        state={composer.state}
        local={false}
        appCommands={false}
        commands={composer.commands}
        onCommand={composer.onCommand}
        takesDraft={false}
        placeholder={t("agentView.remote.placeholder", { device: target.deviceName })}
        below={<UsageLineView line={line} />}
      />
    </>
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
  const read = usePeerTerminal({ deviceId, workspaceId, tabId }, TERMINAL_LINES, visible);
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
