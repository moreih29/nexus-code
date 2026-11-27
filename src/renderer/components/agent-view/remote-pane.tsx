import i18next, { type TFunction } from "i18next";
import { CloudOff } from "lucide-react";
import {
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { RUN_ITEMS_SCHEMA } from "../../../../packages/remote-protocol/src";
import type { ViewGoal } from "../../../../packages/remote-protocol/src/view";
import { appErrorFailed } from "../../../shared/error/app-error";
import { isUnder, shownPath } from "../../../shared/fs/relative-path";
import type { IpcResult } from "../../../shared/ipc/result";
import { shortId } from "../../../shared/util/short-id";
import { useBannerDismissal } from "../../hooks/use-banner-dismissal";
import { useNow } from "../../hooks/use-now";
import { ipcCallResult } from "../../ipc/client";
import { remoteSessionKey } from "../../services/agent-view/layout";
import { forgetRemoteResult, useRemotePaneSeen } from "../../services/agent-view/remote-results";
import { ChatFilesContext } from "../../services/chat/chat-files";
import { configCommandOf } from "../../services/chat/claude/config";
import type { PermissionAnswer } from "../../services/chat/claude/controller";
import { CODEX_COMMANDS, codexStatusMarkdown } from "../../services/chat/codex/commands";
import { emptyCodexModel } from "../../services/chat/codex/model";
import type { PeerSendState } from "../../services/chat/composer-submit";
import type { GoalView } from "../../services/chat/goal";
import { lookAreaOf } from "../../services/chat/look-area";
import type {
  AssistantItem,
  ChatModel,
  PermissionRequest,
  UserItem,
} from "../../services/chat/model";
import { agentTranscript } from "../../services/chat/panel";
import type { CommandCard } from "../../services/chat/store";
import { surfaceError } from "../../services/error-surface/surface-error";
import { modelOfPage } from "../../services/remote/chat-model";
import { remoteGoalView } from "../../services/remote/goal";
import { usePeerChat, type WatchedChat } from "../../services/remote/peer-chat";
import {
  peerChatFiles,
  peerImageLoader,
  usePeerChatAccess,
} from "../../services/remote/peer-chat-media";
import { usePeerComposer } from "../../services/remote/peer-composer";
import {
  putPeerDraft,
  restorePeerComposition,
  usePeerComposition,
} from "../../services/remote/peer-drafts";
import { peerRunRows, usePeerRuns } from "../../services/remote/peer-runs";
import {
  previewOf,
  recoverPeerSubmission,
  usePeerSubmissions,
} from "../../services/remote/peer-submissions";
import { usePeerTerminal, watchPeerTerminalTyping } from "../../services/remote/peer-terminal";
import {
  peerWorkspaceId,
  setPeerRoot,
  usePeerChatFileChanges,
} from "../../services/remote/peer-workspace";
import {
  chatProfileIdThere,
  type PeerReach,
  type PeerRead,
  refreshPeerSessions,
  TERMINAL_PROFILE_SCHEMA,
  usePeerConnection,
  usePeerReadsChats,
  usePeerSendState,
  usePeerSessions,
  usePeerSpeaks,
  usePeerTypes,
} from "../../services/remote/room";
import { useSelfDeviceId } from "../../services/remote/self-device";
import {
  TerminalInputQueueFullError,
  type TerminalTyping,
} from "../../services/remote/terminal-typing";
import { useChatFontStyle } from "../../state/stores/chat-font";
import {
  askOf,
  type OpenRemoteSession,
  openRemoteSession,
  type RemoteTarget,
  refreshRemoteTarget,
} from "../../state/stores/remote-view";
import { cn } from "../../utils/cn";
import { ChatAgentContext } from "../chat/chat-agent";
import { ImageLoaderContext } from "../chat/chat-image";
import { ChatLinksContext, useChatLinks } from "../chat/chat-links";
import {
  ChatEmptyState,
  ChatRequestDock,
  ChatShell,
  RequestDock,
  showsEmptyChat,
  useChatPanelPlace,
  useShownAgent,
} from "../chat/chat-shell";
import { ChatPhaseBanner, ChatSignedOutBanner } from "../chat/chat-state-banner";
import { CommandCardView } from "../chat/command-card";
import { Composer, composerHint, composerKeys } from "../chat/composer";
import { GoalBar, type TabGoal } from "../chat/goal-bar";
import { LimitResumeView, showsLimitResume } from "../chat/limit-resume-banner";
import {
  type CallReveal,
  type MessageActions,
  MessageList,
  type OlderMessages,
  type ShownMove,
} from "../chat/message-list";
import { focusChatTab } from "../chat/permission-card";
import { QuickLook, type QuickLookList } from "../chat/quick-look";
import { RateLimitBanner } from "../chat/rate-limit-banner";
import { RewindDialog } from "../chat/rewind-dialog";
import type { InstructionsChipSlot } from "../chat/session-instructions-chip";
import {
  type RemotePanelAsk,
  type RemotePanelPart,
  remoteAgentsOf,
} from "../chat/session-side-panel";
import { StatusLine } from "../chat/status-line";
import { TerminalTwinBanner } from "../chat/terminal-twin-banner";
import { TurnFailureBanner } from "../chat/turn-failure-banner";
import { UsageLineView } from "../chat/usage-line";
import { BannerDismissButton } from "../ui/banner";
import { showToast } from "../ui/toast";
import { forkPeerChat, peerRewinder } from "./remote-chat-actions";
import { RemoteCodexConfigDialog, RemoteConfigDialog } from "./remote-config-dialog";
import { ConsentPages, consentFromChat, PeerConsentCard, usePeerConsents } from "./remote-consents";
import { RemoteInstructionsChip } from "./remote-instructions-chip";
import { useRemoteLinks } from "./remote-links";
import { RemoteSessionList } from "./remote-past-sessions";
import { RemotePrintRunPane } from "./remote-print-run-pane";
import { peerProfileName, RemoteProfileChip } from "./remote-profile-chip";
import { closePeerSession } from "./remote-session-actions";
import { type RemoteSessionHost, RemoteSessionHostContext } from "./remote-session-host";
import { panelSummaryCounts, RemoteSidePanel, remotePanelPartOf } from "./remote-side-panel";
import { RemoteTerminalAsk } from "./remote-terminal-ask";
import { RemoteTerminalScreen } from "./remote-terminal-screen";
import { rateLimitOf, usageLineOf } from "./remote-usage";

const TERMINAL_LINES = 2000;

const GOAL_STOP_MS = 10_000;

const closedGoals = new Map<string, string>();

export function changesCard(
  changed: NonNullable<WatchedChat["panel"]>["changedFiles"],
  folder: string,
  t: TFunction,
  openChange: (path: string) => void,
): Pick<CommandCard, "sections"> {
  return {
    sections: [
      {
        title: t("chat.panel.changed.title"),
        empty: t("agentView.remote.noChanges"),
        rows: changed.map((file) => ({
          id: file.path,
          label: shownPath(file.path, folder),
          detail: file.created
            ? t("chat.panel.results.created")
            : `+${file.added ?? 0} −${file.removed ?? 0}`,
          actions: [{ label: t("chat.commands.open"), run: () => openChange(file.path) }],
        })),
      },
    ],
  };
}

async function peerProfileIdOf(target: RemoteTarget): Promise<string> {
  if (target.kind !== "claude" && target.kind !== "codex") {
    throw new Error("this chat's profile is not known here");
  }
  const result = await ipcCallResult("remote", "peerProfiles", {
    deviceId: target.deviceId,
    agent: target.kind,
  });
  if (!result.ok) throw new Error(result.message);
  return chatProfileIdThere(target.profile || undefined, result.value.profiles);
}

export function runInPeerTerminal(
  target: RemoteTarget,
  command: string,
  open: OpenRemoteSession = openRemoteSession,
): void {
  const folder =
    target.cwd && target.cwd !== target.path && isUnder(target.cwd, target.path)
      ? target.cwd
      : undefined;
  const failed = (message: string) =>
    showToast({ kind: "error", message: i18next.t("agentView.remote.failed", { message }) });
  void peerProfileIdOf(target).then(
    (profile) => openPeerTerminal(target, command, profile, folder, failed, open),
    (error: Error) => failed(error.message),
  );
}

function openPeerTerminal(
  target: RemoteTarget,
  command: string,
  profile: string,
  folder: string | undefined,
  failed: (message: string) => void,
  open: OpenRemoteSession,
): void {
  const { deviceId, workspaceId } = target;
  void ipcCallResult("remote", "peerTerminalOpen", {
    deviceId,
    workspaceId,
    command,
    profile,
    ...(folder ? { folder } : {}),
  }).then((result) => {
    if (!result.ok) {
      failed(result.message);
      return;
    }
    const { profile: _theirs, cwd: _its, state: _was, ...rest } = target;
    open({
      ...rest,
      kind: "terminal",
      tabId: result.value.tabId,
      title: command,
    });
  });
}

const CODEX_SIGN_IN = "codex login --device-auth";

export function RemoteSessionPane({
  target,
  visible,
  host = null,
}: {
  target: RemoteTarget;
  visible: boolean;
  host?: RemoteSessionHost | null;
}) {
  const { reach, controls } = usePeerConnection(target.deviceId, host === null);
  return (
    <RemoteSessionHostContext.Provider value={host}>
      <div
        className={cn(
          "absolute inset-0 flex min-h-0 min-w-0 flex-col overflow-hidden",
          reach !== "online" && "[&_*]:animate-none!",
        )}
        data-testid="remote-pane"
        data-reach={reach}
      >
        {target.kind === "terminal" ? (
          <RemoteTerminal target={target} visible={visible} reach={reach} controls={controls} />
        ) : (
          <RemoteChat target={target} visible={visible} reach={reach} controls={controls} />
        )}
      </div>
    </RemoteSessionHostContext.Provider>
  );
}

function useSessionGone(gone: boolean): void {
  const onGone = useContext(RemoteSessionHostContext)?.onGone;
  useEffect(() => {
    if (gone) onGone?.();
  }, [gone, onGone]);
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

export function Unreachable({
  reach,
  device,
  goalBar,
  notice,
}: {
  reach: PeerReach;
  device: string;
  goalBar?: React.ReactNode;
  notice?: ReturnType<typeof useBannerDismissal>;
}) {
  const { t } = useTranslation();
  if (notice?.dismissed && !goalBar) return null;
  return (
    <div className="shrink-0 px-4 pt-1 pb-3">
      {goalBar && <div className="mx-auto mb-2 max-w-[860px]">{goalBar}</div>}
      {!notice?.dismissed && (
        <div
          role="status"
          className="mx-auto flex max-w-[860px] items-center gap-2 rounded-(--radius-raised) border border-border border-dashed px-3 py-2.5 text-app-ui-sm text-muted-foreground"
        >
          <CloudOff aria-hidden className="size-3.5 shrink-0" />
          <span className="flex-1">
            {reach === "disconnected"
              ? t("agentView.remote.disconnectedLast")
              : t("agentView.remote.offlineLast", { device })}
          </span>
          {notice && <BannerDismissButton dismiss={notice.dismiss} />}
        </div>
      )}
    </div>
  );
}

function ViewOnly({
  model,
  device,
  goalBar,
  notice,
}: {
  model: ChatModel;
  device: string;
  goalBar?: React.ReactNode;
  notice: ReturnType<typeof useBannerDismissal>;
}) {
  const { t } = useTranslation();
  if (notice.dismissed && !goalBar && !model.running) return null;
  return (
    <div className="shrink-0 px-4 py-2" data-testid="remote-view-only">
      <div className="mx-auto flex max-w-[860px] flex-col gap-2">
        {goalBar}
        {(model.permissions.length > 0 || model.running) && <StatusLine model={model} />}
        {!notice.dismissed && (
          <div className="flex items-center gap-2 rounded-(--radius-raised) border border-border border-dashed px-3 py-2.5 text-app-ui-sm text-muted-foreground">
            <span className="flex-1">{t("agentView.remote.viewOnlyNote", { device })}</span>
            <BannerDismissButton dismiss={notice.dismiss} />
          </div>
        )}
      </div>
    </div>
  );
}

function planModeOf(
  updates: readonly unknown[] | undefined,
): "acceptEdits" | "default" | undefined {
  for (const update of updates ?? []) {
    const { type, mode } = (update ?? {}) as { type?: unknown; mode?: unknown };
    if (type === "setMode" && (mode === "acceptEdits" || mode === "default")) return mode;
  }
  return undefined;
}

export function remoteAnswerOf(
  answer: PermissionAnswer,
  request: PermissionRequest,
  planModeOptions: boolean,
): {
  decision: "allow" | "deny";
  message?: string;
  updatedInput?: Record<string, unknown>;
  stop?: boolean;
  always?: number[];
  planMode?: "acceptEdits" | "default";
} {
  switch (answer.kind) {
    case "allow": {
      const planMode =
        planModeOptions && request.toolName === "ExitPlanMode"
          ? planModeOf(answer.updatedPermissions)
          : undefined;
      return {
        decision: "allow",
        ...(answer.updatedInput ? { updatedInput: answer.updatedInput } : {}),
        ...(planMode ? { planMode } : {}),
      };
    }
    case "allow-always": {
      const always = (answer.suggestions ?? request.suggestions).flatMap((raw) => {
        const index = (raw as { index?: unknown } | null)?.index;
        return typeof index === "number" ? [index] : [];
      });
      return { decision: "allow", ...(always.length > 0 ? { always } : {}) };
    }
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
  controls: boolean;
}) {
  const { deviceId, workspaceId, tabId } = target;
  const { read, sendReady, loadEarlier, loadingEarlier } = usePeerChat(
    { deviceId, workspaceId, tabId },
    visible,
  );
  const peerSend = usePeerSendState(sendReady && controls);
  useSessionGone(visible && read.status === "gone");
  const page = read.status === "ready" ? read.value : null;
  const older = useMemo<OlderMessages | undefined>(
    () =>
      page && page.start > 0
        ? { count: page.start, loading: loadingEarlier, load: loadEarlier }
        : undefined,
    [page, loadingEarlier, loadEarlier],
  );
  const selfId = useSelfDeviceId();
  const { deviceName } = target;
  const model = useMemo(
    () =>
      page ? modelOfPage(page, { deviceId, deviceName, ...(selfId ? { selfId } : {}) }) : null,
    [page, deviceId, deviceName, selfId],
  );
  if (read.status !== "ready" || !page || !model) {
    return <Waiting read={read} reach={reach} device={target.deviceName} />;
  }
  return (
    <ChatAgentContext.Provider value={target.kind === "codex" ? "codex" : "claude"}>
      <RemoteChatView
        target={target}
        page={page}
        model={model}
        {...(older ? { older } : {})}
        visible={visible}
        reach={reach}
        peerSend={peerSend}
        controls={controls}
        selfId={selfId}
      />
    </ChatAgentContext.Provider>
  );
}

function useRemoteGoal(
  view: ViewGoal | null | undefined,
  agent: "claude" | "codex",
): GoalView | null {
  const seen = useRef<{ key: string; endedAt?: number } | null>(null);
  if (!view) return null;
  const goal = remoteGoalView(view, agent);
  if (!goal.ended) {
    seen.current = { key: goal.key };
    return goal;
  }
  if (goal.durationMs !== undefined) return goal;
  if (seen.current?.key === goal.key && goal.setAt !== undefined) {
    seen.current.endedAt ??= Date.now();
    return { ...goal, durationMs: seen.current.endedAt - goal.setAt };
  }
  const { setAt: _unknown, ...untimed } = goal;
  return untimed;
}

const NO_CHANGES: readonly never[] = [];

function RemoteChatView({
  target,
  page,
  model,
  older,
  visible,
  reach,
  peerSend,
  controls,
  selfId,
}: {
  target: RemoteTarget;
  page: WatchedChat;
  model: ChatModel;
  older?: OlderMessages;
  visible: boolean;
  reach: PeerReach;
  peerSend: PeerSendState;
  controls: boolean;
  selfId?: string;
}) {
  const { t } = useTranslation();
  const host = useContext(RemoteSessionHostContext);
  const open = host?.openSession ?? openRemoteSession;
  const { deviceId, workspaceId, tabId } = target;
  const listed = usePeerSessions([deviceId], visible && reach === "online")[deviceId];
  const list = listed?.status === "ready" ? listed.list : undefined;
  const session = list?.sessions.find((s) => s.workspaceId === workspaceId && s.tabId === tabId);
  useRemotePaneSeen(deviceId, session, visible && reach === "online");
  const consents = usePeerConsents(deviceId, host ? undefined : list?.consents).filter((consent) =>
    consentFromChat(consent, target),
  );
  const consentCards = consents.length ? (
    <ConsentPages place={JSON.stringify(["pane", deviceId, workspaceId, tabId])}>
      {consents.map((consent) => (
        <PeerConsentCard
          key={consent.id}
          consent={controls ? consent : { ...consent, answerable: false }}
          deviceId={deviceId}
          device={target.deviceName}
          sessions={list?.sessions}
          workspaceName={
            list?.workspaces.find((workspace) => workspace.id === consent.workspaceId)?.name ??
            shortId(consent.workspaceId)
          }
        />
      ))}
    </ConsentPages>
  ) : null;
  const submissions = usePeerSubmissions({ deviceId, workspaceId, tabId });
  const previewItems = useMemo(() => {
    const visible = submissions.filter(
      (entry) => entry.status !== "sending" || !entry.provisionalEcho,
    );
    return visible.length ? [...model.items, ...visible.map(previewOf)] : model.items;
  }, [model.items, submissions]);
  const recover = (key: string) => {
    const ref = { deviceId, workspaceId, tabId };
    const submission = recoverPeerSubmission(ref, key.replace(/^pending:/, ""));
    if (submission) {
      restorePeerComposition(ref, submission);
      focusChatTab(rootRef.current);
    }
  };
  const fontStyle = useChatFontStyle();
  const claude = target.kind !== "codex";
  const sessionKey = remoteSessionKey(target);
  const focusKey = host?.focusKey ?? sessionKey;
  const shell = useChatPanelPlace(focusKey, visible);
  const { rootRef } = shell;
  const [panelAsk, setPanelAsk] = useState<RemotePanelAsk | null>(null);
  const askPanel = (part: RemotePanelPart, id?: string) =>
    setPanelAsk((prev) => ({ part, seq: (prev?.seq ?? 0) + 1, ...(id ? { id } : {}) }));
  // biome-ignore lint/correctness/useExhaustiveDependencies: each ask once, where the panel then is
  useEffect(() => {
    if (panelAsk) shell.openPanel();
  }, [panelAsk?.seq]);

  const runs = usePeerRuns({ deviceId, workspaceId, tabId }, visible && reach === "online");
  const runRows = useMemo(() => peerRunRows(runs), [runs]);
  const agents = useMemo(
    () => [...remoteAgentsOf(page.panel, model), ...runRows],
    [page.panel, model, runRows],
  );
  const { shown, showAgent, onKeyDown } = useShownAgent(agents, shell);
  const taskShower = useRef<NonNullable<MessageActions["taskShower"]>>(() => undefined);
  taskShower.current = (item) => {
    const toolUseId =
      model.tasks[item.taskId]?.toolUseId ??
      item.toolUseId ??
      agents.find((a) => a.taskId === item.taskId)?.toolUseId;
    if (toolUseId && agents.some((a) => a.toolUseId === toolUseId)) {
      return () => showAgent(toolUseId);
    }
    return claude && page.panel?.tasks.some((job) => job.taskId === item.taskId)
      ? () => askPanel("jobs", item.taskId)
      : undefined;
  };
  const [callAsk, setCallAsk] = useState<CallReveal | null>(null);
  const showCall = (toolUseId: string) => {
    showAgent(null);
    setCallAsk((prev) => ({ toolUseId, seq: (prev?.seq ?? 0) + 1 }));
  };
  const ref = { deviceId, workspaceId, tabId };
  const reachable = controls && reach === "online";
  const bannerScope = ["remote-chat", deviceId, workspaceId, tabId, page.panel?.session?.id];
  const unreachableNotice = useBannerDismissal(
    [...bannerScope, "unreachable"],
    reach !== "online" ? [reach] : undefined,
    true,
  );
  const viewOnlyNotice = useBannerDismissal(
    [...bannerScope, "view-only"],
    controls ? undefined : [true],
    true,
  );
  const types = usePeerTypes(deviceId);
  const inProfile = usePeerSpeaks(deviceId, TERMINAL_PROFILE_SCHEMA);
  const hasCodexCommands = usePeerSpeaks(deviceId, "0.13.0");

  const running = model.running;
  const can = reachable ? page.panel?.can : undefined;
  const [rewinding, setRewinding] = useState<UserItem | null>(null);
  const rewinder = useMemo(
    () => peerRewinder({ deviceId, workspaceId, tabId }),
    [deviceId, workspaceId, tabId],
  );
  const forkFrom = useRef<(itemKey?: string) => void>(() => undefined);
  forkFrom.current = (itemKey) => {
    const from = itemKey
      ? model.items.find((i) => i.kind === "user" && (i.uuid ?? i.key) === itemKey)
      : undefined;
    void forkPeerChat(target, itemKey, from?.kind === "user" ? from : undefined, open);
  };
  const canRewind = can?.rewind === true;
  const canFork = can?.fork === true;
  const canBackground = can?.background === true;
  const asking = model.permissions;
  const actions = useMemo<MessageActions>(
    () => ({
      running,
      canFork,
      ...(!claude
        ? {
            canForkItem: (item: UserItem | AssistantItem) => item.forkable === true,
            canRewindItem: (item: UserItem) => item.rewindable === true,
          }
        : {}),
      ...(canRewind ? { onRewind: (item: UserItem) => setRewinding(item) } : {}),
      ...(canFork
        ? { onFork: (item: UserItem | AssistantItem) => forkFrom.current(item.uuid ?? item.key) }
        : {}),
      ...(canBackground
        ? {
            onBackground: (toolUseId: string) =>
              void ipcCallResult("remote", "peerChatBackground", {
                deviceId,
                workspaceId,
                tabId,
                toolUseId,
              }).then((result) => {
                if (!result.ok) showToast({ kind: "error", message: result.message });
              }),
          }
        : {}),
      waiting: new Set(asking.flatMap((p) => (p.toolUseId ? [p.toolUseId] : []))),
      taskShower: (item) => taskShower.current(item),
    }),
    [running, canFork, canRewind, canBackground, claude, asking, deviceId, workspaceId, tabId],
  );

  const movedThere = page.panel?.moves;
  const moves = useMemo<ShownMove[] | undefined>(
    () =>
      movedThere?.map((move) => ({
        profileId: `remote:${move.profile}`,
        after: move.after,
        at: move.at,
        label: peerProfileName(move.profile, t),
      })),
    [movedThere, t],
  );

  const mediaAccess = usePeerChatAccess(deviceId);
  const runId = shown?.run?.id;
  const readsRunItems = usePeerSpeaks(deviceId, RUN_ITEMS_SCHEMA);
  const loadRunImage = useMemo(
    () =>
      readsRunItems && runId !== undefined
        ? peerImageLoader({ deviceId, workspaceId, tabId, runId }, mediaAccess, visible)
        : null,
    [deviceId, workspaceId, tabId, runId, mediaAccess, visible, readsRunItems],
  );
  const loadImage = useMemo(
    () => peerImageLoader({ deviceId, workspaceId, tabId }, mediaAccess, visible),
    [deviceId, workspaceId, tabId, mediaAccess, visible],
  );
  const files = useMemo(
    () => peerChatFiles({ deviceId, workspaceId, tabId }, mediaAccess, visible),
    [deviceId, workspaceId, tabId, mediaAccess, visible],
  );
  const peerWorkspace = peerWorkspaceId(deviceId, workspaceId);
  useEffect(() => setPeerRoot(peerWorkspace, target.path), [peerWorkspace, target.path]);
  usePeerChatFileChanges(peerWorkspace, page.panel?.changedFiles ?? NO_CHANGES, model.tools);
  const [look, setLook] = useState<(QuickLookList & { runId?: string }) | null>(null);
  const links = useRemoteLinks(target, { model }, files, setLook, host?.openFileBeside);
  useEffect(() => {
    setLook((current) =>
      visible && (current?.runId === undefined || current.runId === runId) ? current : null,
    );
  }, [visible, runId]);

  const goal = useRemoteGoal(page.panel?.goal, claude ? "claude" : "codex");
  const [, goalClosed] = useReducer((n: number) => n + 1, 0);
  const closedGoal = closedGoals.get(sessionKey);
  const closeGoal = (key: string) => {
    closedGoals.set(sessionKey, key);
    goalClosed();
  };
  const goalNow: TabGoal | null = goal
    ? {
        goal,
        running: model.running,
        ...(model.turn?.startedAt !== undefined ? { startedAt: model.turn.startedAt } : {}),
      }
    : null;
  const tabGoal = goal && !(goal.ended && closedGoal === goal.key) ? goalNow : null;
  const runningNow = useRef(model.running);
  runningNow.current = model.running;
  const asked = async (sent: Promise<IpcResult<unknown>>) => {
    const result = await sent;
    if (!result.ok) throw new Error(result.message);
  };
  const clearGoal = async () => {
    if (!reachable)
      throw new Error(t("agentView.remote.viewOnlyNote", { device: target.deviceName }));
    if (!claude) {
      await asked(
        ipcCallResult("remote", "peerChatCommand", { ...ref, name: "goal", args: "clear" }),
      );
      return;
    }
    if (runningNow.current) {
      await ipcCallResult("remote", "peerChatInterrupt", ref);
      const deadline = Date.now() + GOAL_STOP_MS;
      while (runningNow.current && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    await asked(ipcCallResult("remote", "peerChatSend", { ...ref, text: "/goal clear" }));
  };
  const goalBar = tabGoal ? (
    <GoalBar
      tab={tabGoal}
      onClear={clearGoal}
      {...(!claude && reachable
        ? {
            onStatus: (status: "active" | "paused") =>
              asked(
                ipcCallResult("remote", "peerChatCommand", {
                  ...ref,
                  name: "goal",
                  args: status === "paused" ? "pause" : "resume",
                }),
              ),
          }
        : {})}
      onClose={() => closeGoal(tabGoal.goal.key)}
    />
  ) : null;

  const told = (sent: Promise<IpcResult<unknown>>) =>
    void sent.then((result) => {
      if (!result.ok) {
        showToast({
          kind: "error",
          message: t("agentView.remote.failed", { message: result.message }),
        });
      }
    });
  const signInThere = () => runInPeerTerminal(target, CODEX_SIGN_IN, open);
  const twin = page.panel ? (page.panel.twin?.tabId ?? null) : undefined;
  const twinSession = twin
    ? list?.sessions.find(
        (s) => s.workspaceId === workspaceId && s.tabId === twin && s.kind === "terminal",
      )
    : undefined;
  const showTwin = twinSession
    ? () => {
        const { profile: _theirs, cwd: _its, state: _was, ask: _asked, ...rest } = target;
        open(
          refreshRemoteTarget(
            { ...rest, kind: "terminal", tabId: twinSession.tabId, title: twinSession.title },
            list?.workspaces.find((workspace) => workspace.id === workspaceId),
            twinSession,
          ),
        );
      }
    : undefined;
  const twinBanner =
    claude && visible ? (
      <TerminalTwinBanner scope={[...bannerScope, "terminal-twin"]} twin={twin} onShow={showTwin} />
    ) : null;
  const panel = (className: string) => (
    <RemoteSidePanel
      target={target}
      panel={page.panel}
      model={model}
      runs={runRows}
      controls={reachable}
      onShowAgent={showAgent}
      onShowCall={showCall}
      onCompact={
        claude
          ? () => told(ipcCallResult("remote", "peerChatSend", { ...ref, text: "/compact" }))
          : (hasCodexCommands || can?.mcpStatus) &&
              page.status.phase === "ready" &&
              !page.status.signedOut
            ? () =>
                asked(
                  ipcCallResult("remote", "peerChatCommand", { ...ref, name: "compact", args: "" }),
                )
            : undefined
      }
      onStopTask={
        claude
          ? (taskId) => told(ipcCallResult("remote", "peerChatStopTask", { ...ref, taskId }))
          : undefined
      }
      signedOut={page.status.signedOut}
      onRefreshMcp={
        can?.mcpStatus && page.status.phase === "ready" && model.process === "running"
          ? () =>
              asked(
                ipcCallResult("remote", "peerChatCommand", {
                  ...ref,
                  name: "mcp",
                  args: "refresh",
                }),
              )
          : undefined
      }
      onStopRun={(runId) => told(ipcCallResult("remote", "peerChatStopRun", { ...ref, runId }))}
      {...(reachable && page.panel?.remoteControl
        ? {
            onRemoteControl: (enabled: boolean) =>
              asked(ipcCallResult("remote", "peerChatRemoteControl", { ...ref, enabled })),
          }
        : {})}
      {...(canFork ? { onForkSession: () => forkFrom.current() } : {})}
      {...(actions.onBackground ? { onBackground: actions.onBackground } : {})}
      reveal={panelAsk}
      goal={goalNow}
      className={className}
    />
  );

  return (
    <ImageLoaderContext.Provider value={loadImage}>
      <ChatFilesContext.Provider value={files}>
        <ChatLinksContext.Provider value={links}>
          {/* biome-ignore lint/a11y/noStaticElementInteractions: ⌘[ and ⌘] step through the agents from anywhere in the chat */}
          <div
            ref={rootRef}
            className="chat-font relative flex min-h-0 flex-1 flex-col bg-background"
            style={fontStyle}
            data-testid="remote-chat"
            data-chat-drop
            onKeyDown={onKeyDown}
          >
            <ChatPhaseBanner
              scope={bannerScope}
              status={page.status}
              {...(reachable && page.status.phase
                ? { onRestart: () => told(ipcCallResult("remote", "peerChatRestart", ref)) }
                : {})}
            />
            <ChatSignedOutBanner
              scope={bannerScope}
              status={page.status}
              {...(reachable && types && inProfile ? { onSignIn: signInThere } : {})}
              {...(reachable
                ? {
                    onCheck: () => told(ipcCallResult("remote", "peerChatCheckSignIn", ref)),
                  }
                : {})}
            />
            <ChatShell
              shell={shell}
              agents={agents}
              shown={shown}
              onShowAgent={showAgent}
              summaryCounts={() => panelSummaryCounts(page.panel, agents)}
              panel={panel}
            >
              {shown?.run ? (
                <RemotePrintRunPane
                  key={shown.run.id}
                  target={target}
                  row={shown.run}
                  visible={visible}
                  controls={reachable}
                  loadImage={loadRunImage}
                  onLook={(list) => setLook({ ...list, runId })}
                />
              ) : (
                <MessageList
                  workspaceId={peerWorkspace}
                  cwd={target.cwd ?? target.path}
                  rootPath={target.path}
                  history={null}
                  model={
                    shown || previewItems === model.items
                      ? model
                      : { ...model, items: previewItems }
                  }
                  actions={shown ? undefined : { ...actions, onRecoverSubmission: recover }}
                  items={shown ? agentTranscript(model, shown) : undefined}
                  itemsDone={shown !== undefined && shown.status !== "running"}
                  reveal={shown ? null : callAsk}
                  {...(moves ? { moves } : {})}
                  {...(older && !shown ? { older } : {})}
                  empty={
                    !shown && showsEmptyChat(page.status.phase) ? (
                      <ChatEmptyState
                        agent={claude ? "claude" : "codex"}
                        cwd={target.cwd ?? target.path}
                      >
                        {reachable && <RemoteSessionList target={target} />}
                      </ChatEmptyState>
                    ) : undefined
                  }
                />
              )}
              {reach !== "online" ? (
                <Unreachable
                  reach={reach}
                  device={target.deviceName}
                  goalBar={goalBar}
                  notice={unreachableNotice}
                />
              ) : !controls ? (
                <>
                  {consentCards && <RequestDock>{consentCards}</RequestDock>}
                  <ViewOnly
                    model={model}
                    device={target.deviceName}
                    goalBar={goalBar}
                    notice={viewOnlyNotice}
                  />
                </>
              ) : (
                <RemoteControls
                  target={target}
                  model={model}
                  page={page}
                  visible={visible}
                  peerSend={peerSend}
                  toMain={shown !== undefined}
                  onShowMain={() => showAgent(null)}
                  goalBar={goalBar}
                  consentCards={consentCards}
                  twinBanner={twinBanner}
                  onPanelPart={askPanel}
                  selfId={selfId}
                />
              )}
            </ChatShell>
            {canRewind && (
              <RewindDialog
                controller={rewinder}
                conversationOnly={!claude}
                item={rewinding}
                cwd={target.cwd ?? target.path}
                onClose={() => setRewinding(null)}
              />
            )}
            {visible && look && (look.runId === undefined || look.runId === runId) && (
              <ImageLoaderContext.Provider
                value={look.runId === undefined ? loadImage : loadRunImage}
              >
                <QuickLook
                  workspaceId={peerWorkspace}
                  peerRoot={target.path}
                  list={look}
                  area={lookAreaOf(rootRef.current)}
                  local={false}
                  onIndex={(index) => setLook({ ...look, index })}
                  onClose={() => setLook(null)}
                  openBesideInWorkspace={host !== null}
                  onOpenBeside={(path, options) => {
                    if (!links.openBeside(path, options)) return false;
                    setLook(null);
                    return true;
                  }}
                />
              </ImageLoaderContext.Provider>
            )}
          </div>
        </ChatLinksContext.Provider>
      </ChatFilesContext.Provider>
    </ImageLoaderContext.Provider>
  );
}

function RemoteControls({
  target,
  model,
  page,
  visible,
  peerSend,
  toMain,
  onShowMain,
  goalBar,
  consentCards,
  twinBanner,
  onPanelPart,
  selfId,
}: {
  target: RemoteTarget;
  selfId?: string;
  model: ChatModel;
  page: WatchedChat;
  visible: boolean;
  peerSend: PeerSendState;
  toMain: boolean;
  onShowMain: () => void;
  goalBar?: React.ReactNode;
  consentCards: React.ReactNode;
  twinBanner?: React.ReactNode;
  onPanelPart?: (part: RemotePanelPart) => void;
}) {
  const { t } = useTranslation();
  const host = useContext(RemoteSessionHostContext);
  const open = host?.openSession ?? openRemoteSession;
  const links = useChatLinks();
  const agent = target.kind === "codex" ? "codex" : "claude";
  const { deviceId, workspaceId, tabId } = target;
  const peerTakesPlanMode = usePeerSpeaks(deviceId, "0.13.0");
  const planModeOptions = agent === "claude" && peerTakesPlanMode;
  const folder = target.cwd ?? target.path;
  const types = usePeerTypes(deviceId);
  const readsChats = usePeerReadsChats(deviceId);
  const { deviceName, profile, workspaceName } = target;
  const instructions = useCallback(
    (slot: InstructionsChipSlot) => (
      <RemoteInstructionsChip
        chat={{ deviceId, workspaceId, tabId }}
        deviceName={deviceName}
        {...(profile ? { profile } : {})}
        workspaceName={workspaceName}
        controls
        {...slot}
      />
    ),
    [deviceId, workspaceId, tabId, deviceName, profile, workspaceName],
  );
  const inProfile = usePeerSpeaks(deviceId, TERMINAL_PROFILE_SCHEMA);
  const configurable = page.panel?.can?.config === true;
  const paneCommands = useMemo(
    () =>
      agent === "codex"
        ? CODEX_COMMANDS.filter(
            (c) =>
              ["resume", "context", "usage"].includes(c.name) ||
              (c.name === "config" && configurable),
          )
        : [],
    [agent, configurable],
  );
  const onError = useCallback(
    (message: string) =>
      showToast({ kind: "error", message: t("agentView.remote.failed", { message }) }),
    [t],
  );
  const composition = usePeerComposition({ deviceId, workspaceId, tabId });
  const composer = usePeerComposer({
    ref: { deviceId, workspaceId, tabId },
    agent: target.kind === "codex" ? "codex" : "claude",
    model,
    panel: page.panel,
    submissionContext: () => ({ selfId, baseline: page.total, showMain: onShowMain }),
    active: visible,
    filesRefused: t("agentView.remote.filesRefused"),
    onError,
    folders: { root: target.path, cwd: target.cwd ?? target.path },
    here: {
      items: () => model.items,
      showChanges: () => {
        const changed = page.panel?.changedFiles ?? [];
        if (changed.length === 0) {
          showToast({ kind: "info", message: t("agentView.remote.noChanges") });
          return undefined;
        }
        if (agent === "codex")
          return changesCard(changed, folder, t, (path) => links?.openChange(path));
        onPanelPart?.("changes");
        return undefined;
      },
      status: () =>
        codexStatusMarkdown(
          {
            ...emptyCodexModel(),
            ...model,
            ...(page.status.signedOut ? { account: null } : {}),
          },
          folder,
          t,
        ),
      openUrl: (url) => links?.openUrl(url),
      exit: host?.hideSession ?? (() => void closePeerSession(target)),
      ...(types && inProfile
        ? {
            terminal: {
              run: (line: string) => runInPeerTerminal(target, line, open),
              ...(page.status.phase
                ? {
                    restart: () =>
                      void ipcCallResult("remote", "peerChatRestart", {
                        deviceId,
                        workspaceId,
                        tabId,
                      }).then((result) => {
                        if (!result.ok) onError(result.message);
                      }),
                  }
                : {}),
            },
          }
        : {}),
    },
    paneCommands,
    onOpened: (opened, draft) => {
      if (draft) putPeerDraft({ deviceId, workspaceId, tabId: opened }, draft);
      open({ ...target, tabId: opened, state: "idle" });
    },
  });
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
        ...remoteAnswerOf(given, request, planModeOptions),
      }),
    );
  const [resumeQuery, setResumeQuery] = useState<string | null>(null);
  const [config, setConfig] = useState<{ focus?: string } | null>(null);
  const onCommand = (text: string): boolean => {
    const opened =
      page.panel?.can?.config !== true
        ? null
        : agent === "claude"
          ? configCommandOf(text)
          : /^\/(config|settings)$/i.test(text.trim())
            ? {}
            : null;
    if (opened) {
      setConfig(opened);
      return true;
    }
    const part = remotePanelPartOf(text);
    if (
      part &&
      onPanelPart &&
      (agent === "claude" || (part !== "status" && part !== "mcp") || page.panel?.can?.mcpStatus)
    ) {
      onPanelPart(part);
      return true;
    }
    const resume = /^\/resume(?:\s+([\s\S]*))?$/.exec(text.trim());
    if (resume) {
      if (model.running) showToast({ kind: "warning", message: t("chat.commands.resume_busy") });
      else setResumeQuery(resume[1]?.trim() ?? "");
      return true;
    }
    return composer.onCommand(text);
  };
  const now = useNow(visible, 60_000);
  const line = useMemo(() => usageLineOf(page.panel, now), [page.panel, now]);
  const bannerScope = ["remote-chat", deviceId, workspaceId, tabId, page.panel?.session?.id];
  const limit = useMemo(() => rateLimitOf(page.panel, now), [page.panel, now]);
  const chat =
    target.kind === "codex"
      ? { ...target, kind: "codex" as const }
      : { ...target, kind: "claude" as const };
  return (
    <>
      <ChatRequestDock
        model={model}
        goal={goalBar}
        extra={consentCards}
        card={{
          workspaceId: peerWorkspaceId(deviceId, workspaceId),
          cwd: target.cwd ?? target.path,
          rootPath: target.path,
          planModeOptions,
          onAnswer: answer,
        }}
        {...(toMain ? { onToMain: onShowMain } : {})}
      />
      <LimitResumeView scope={bannerScope} record={page.panel?.limitResume} />
      {!showsLimitResume(page.panel?.limitResume) && (
        <RateLimitBanner scope={bannerScope} limit={limit} />
      )}
      <TurnFailureBanner
        scope={bannerScope}
        model={model}
        onRetry={(text) =>
          composer.controller.send(text).catch((error: Error) => {
            onError(error.message);
          })
        }
      />
      {twinBanner}
      <Composer
        key={composer.controller.key}
        controller={composer.controller}
        composition={composition}
        peerSend={peerSend}
        takesDraft={false}
        state={composer.state}
        local={false}
        appCommands={false}
        {...(readsChats ? { instructions } : {})}
        commands={composer.commands}
        onCommand={onCommand}
        placeholder={
          toMain
            ? t("chat.strip.input_to_main")
            : model.running
              ? composerHint(t, true, target.kind === "codex" ? "codex" : "claude")
              : t("agentView.remote.placeholder", {
                  device: target.deviceName,
                  ...composerKeys(),
                  ...(target.kind === "codex" ? { context: "codex" } : {}),
                })
        }
        above={
          resumeQuery !== null ? (
            <RemoteSessionList
              target={target}
              query={resumeQuery}
              onClose={() => setResumeQuery(null)}
              {...(model.sessionId ? { exceptSessionId: model.sessionId } : {})}
            />
          ) : (
            composer.card && (
              <CommandCardView
                card={composer.card}
                workspaceId={peerWorkspaceId(deviceId, workspaceId)}
                cwd={target.cwd ?? target.path}
                rootPath={target.path}
                onClose={composer.closeCard}
              />
            )
          )
        }
        below={
          <UsageLineView
            line={line}
            trailing={(compact) => (
              <RemoteProfileChip
                target={chat}
                busy={model.running || model.permissions.length > 0}
                moveNow={page.panel?.can?.moveNow === true}
                conversation={model.items.length > 0}
                controls
                compact={compact}
              />
            )}
          />
        }
      />
      {agent === "claude" ? (
        <RemoteConfigDialog
          chat={{ deviceId, workspaceId, tabId }}
          running={model.running}
          open={config !== null}
          focus={config?.focus}
          onClose={() => setConfig(null)}
        />
      ) : (
        <RemoteCodexConfigDialog
          chat={{ deviceId, workspaceId, tabId }}
          open={config !== null}
          onClose={() => setConfig(null)}
        />
      )}
    </>
  );
}

function RemoteTerminal({
  target,
  visible,
  reach,
  controls,
}: {
  target: RemoteTarget;
  visible: boolean;
  reach: PeerReach;
  controls: boolean;
}) {
  const { t } = useTranslation();
  const { deviceId, workspaceId, tabId } = target;
  const read = usePeerTerminal({ deviceId, workspaceId, tabId }, TERMINAL_LINES, visible);
  useSessionGone(visible && read.status === "gone");
  useEffect(() => {
    if (visible && read.status === "gone") forgetRemoteResult({ deviceId, workspaceId, tabId });
  }, [deviceId, read.status, tabId, visible, workspaceId]);
  const types = usePeerTypes(deviceId);
  const [answered, setAnswered] = useState<string | null>(null);
  const listed = usePeerSessions([deviceId], visible)[deviceId];
  const session =
    listed?.status === "ready"
      ? listed.list.sessions.find((s) => s.workspaceId === workspaceId && s.tabId === tabId)
      : undefined;
  useRemotePaneSeen(deviceId, session, visible && reach === "online");
  const ask = listed?.status === "ready" ? (session ? askOf(session) : undefined) : target.ask;
  const [typing, setTyping] = useState<TerminalTyping | null>(null);
  useLayoutEffect(() => {
    setTyping(null);
    return watchPeerTerminalTyping({ deviceId, workspaceId, tabId }, setTyping, (error) => {
      const code =
        error instanceof TerminalInputQueueFullError ? error.code : "terminal-input-failed";
      surfaceError(appErrorFailed(String(error), { code }), { surface: "toast" });
    });
  }, [deviceId, workspaceId, tabId]);
  const terminalScope = ["remote-terminal", deviceId, workspaceId, tabId];
  const unreachableNotice = useBannerDismissal(
    [...terminalScope, "unreachable"],
    reach !== "online" ? [reach] : undefined,
    true,
  );
  const viewOnlyNotice = useBannerDismissal(
    [...terminalScope, "view-only"],
    types ? undefined : [true],
    true,
  );
  if (read.status !== "ready") {
    return <Waiting read={read} reach={reach} device={target.deviceName} />;
  }
  return (
    <>
      <RemoteTerminalScreen
        text={read.value.text}
        {...(read.value.caret ? { caret: read.value.caret } : {})}
        {...(typing && visible && types && reach === "online" ? { typing } : {})}
      />
      {visible && reach === "online" && controls && ask && ask.requestId !== answered && (
        <RemoteTerminalAsk
          key={ask.requestId}
          ask={ask}
          onAnswer={(decision) =>
            ipcCallResult("remote", "peerTerminalAnswer", {
              deviceId,
              workspaceId,
              tabId,
              requestId: ask.requestId,
              decision,
            })
          }
          onAnswered={() => {
            setAnswered(ask.requestId);
            refreshPeerSessions(deviceId);
          }}
        />
      )}
      {reach !== "online" ? (
        <Unreachable reach={reach} device={target.deviceName} notice={unreachableNotice} />
      ) : (
        !types &&
        !viewOnlyNotice.dismissed && (
          <div
            className="flex shrink-0 items-center gap-2 border-border border-t px-3 py-1.5 text-app-micro text-muted-foreground"
            data-testid="remote-terminal-view-only"
          >
            <span className="flex-1">
              {t("agentView.remote.terminalViewOnly", { device: target.deviceName })}
            </span>
            <BannerDismissButton dismiss={viewOnlyNotice.dismiss} />
          </div>
        )
      )}
    </>
  );
}
