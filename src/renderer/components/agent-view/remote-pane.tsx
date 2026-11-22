import i18next, { type TFunction } from "i18next";
import { ArrowLeft, CloudOff } from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import type { ViewGoal } from "../../../../packages/remote-protocol/src/view";
import { appErrorFailed } from "../../../shared/error/app-error";
import { remoteFileKey } from "../../../shared/fs/remote-file-key";
import type { IpcResult } from "../../../shared/ipc/result";
import { useBannerDismissal } from "../../hooks/use-banner-dismissal";
import { useNow } from "../../hooks/use-now";
import { ipcCallResult } from "../../ipc/client";
import { remoteSessionKey } from "../../services/agent-view/layout";
import { ChatFilesContext } from "../../services/chat/chat-files";
import { configCommandOf } from "../../services/chat/claude/config";
import type { PermissionAnswer } from "../../services/chat/claude/controller";
import { CODEX_COMMANDS, codexStatusMarkdown } from "../../services/chat/codex/commands";
import { emptyCodexModel } from "../../services/chat/codex/model";
import type { GoalView } from "../../services/chat/goal";
import { isUnder } from "../../services/chat/links";
import { lookAreaOf } from "../../services/chat/look-area";
import type {
  AssistantItem,
  ChatModel,
  PermissionRequest,
  UserItem,
} from "../../services/chat/model";
import { agentTranscript } from "../../services/chat/panel";
import { registerPanelToggle } from "../../services/chat/panel-toggle";
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
  usePeerControls,
  usePeerReach,
  usePeerSessions,
  usePeerSpeaks,
  usePeerTypes,
} from "../../services/remote/room";
import { useSelfDeviceId } from "../../services/remote/self-device";
import {
  TerminalInputQueueFullError,
  type TerminalTyping,
} from "../../services/remote/terminal-typing";
import { registerTabFocusTarget, requestTabFocus } from "../../services/tab-focus";
import { useAgentViewStore } from "../../state/stores/agent-view";
import { useChatFontStyle } from "../../state/stores/chat-font";
import { askOf, type RemoteTarget, useRemoteViewStore } from "../../state/stores/remote-view";
import { cn } from "../../utils/cn";
import { ClaudeIcon, CodexIcon } from "../chat/agent-icons";
import { AgentStrip, ShownState } from "../chat/agent-strip";
import { ChatAgentContext } from "../chat/chat-agent";
import { ImageLoaderContext } from "../chat/chat-image";
import { ChatLinksContext, useChatLinks } from "../chat/chat-links";
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
import { type PanelPlace, placeFor, readPanelPref, writePanelPref } from "../chat/panel-place";
import { focusChatTab, PermissionCard } from "../chat/permission-card";
import { QuickLook, type QuickLookList } from "../chat/quick-look";
import { RateLimitBanner } from "../chat/rate-limit-banner";
import { RewindDialog } from "../chat/rewind-dialog";
import { shortPath } from "../chat/side-panel";
import { StatusLine } from "../chat/status-line";
import { SummaryLine } from "../chat/summary-line";
import { UsageLineView } from "../chat/usage-line";
import { BannerDismissButton } from "../ui/banner";
import { showToast } from "../ui/toast";
import { forkPeerChat, peerRewinder } from "./remote-chat-actions";
import { RemoteCodexConfigDialog, RemoteConfigDialog } from "./remote-config-dialog";
import { consentFromChat, PeerConsentCard, usePeerConsents } from "./remote-consents";
import { useRemoteLinks } from "./remote-links";
import { RemoteSessionList } from "./remote-past-sessions";
import { RemotePrintRunPane } from "./remote-print-run-pane";
import { peerProfileName, RemoteProfileChip } from "./remote-profile-chip";
import { closePeerSession } from "./remote-session-actions";
import {
  panelSummaryCounts,
  type RemotePanelAsk,
  type RemotePanelPart,
  RemoteSidePanel,
  remoteAgentsOf,
  remotePanelPartOf,
} from "./remote-side-panel";
import { RemoteTerminalAsk } from "./remote-terminal-ask";
import { RemoteTerminalScreen } from "./remote-terminal-screen";
import { rateLimitOf, usageLineOf } from "./remote-usage";

/** How many lines of a terminal are shown. */
const TERMINAL_LINES = 2000;

/** How long clearing a Claude goal waits for the turn it stopped to end, as a chat here does. */
const GOAL_STOP_MS = 10_000;

/**
 * The ended goal whose bar was closed, by each chat's session key: kept
 * while the app runs, as a chat here keeps it in its tab's state, so a
 * chat opened again or put back in sight does not show it again.
 */
const closedGoals = new Map<string, string>();

/** A Codex chat's changed files as a card, as /diff shows them: each opens its diff. */
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
          label: shortPath(file.path, folder),
          detail: file.created
            ? t("chat.panel.results.created")
            : `+${file.added ?? 0} −${file.removed ?? 0}`,
          actions: [{ label: t("chat.commands.open"), run: () => openChange(file.path) }],
        })),
      },
    ],
  };
}

/**
 * The id there of the profile the chat runs with, of its agent's profiles
 * its computer lists: by the chat's profile's name, or the only one where
 * the chat names none (a session names its profile only where there are
 * more than one).
 */
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

/**
 * Runs a command in a new terminal of the chat's computer, in the chat's
 * folder where that is in its workspace, and shows the terminal here, as a
 * chat here runs one in a terminal of its own: in the chat's profile, as
 * its program runs (a sign-in there is the profile's, not the default
 * folder's).
 */
export function runInPeerTerminal(target: RemoteTarget, command: string): void {
  // A folder outside its workspace is not one a terminal there opens in.
  const folder =
    target.cwd && target.cwd !== target.path && isUnder(target.cwd, target.path)
      ? target.cwd
      : undefined;
  const failed = (message: string) =>
    showToast({ kind: "error", message: i18next.t("agentView.remote.failed", { message }) });
  void peerProfileIdOf(target).then(
    (profile) => openPeerTerminal(target, command, profile, folder, failed),
    (error: Error) => failed(error.message),
  );
}

function openPeerTerminal(
  target: RemoteTarget,
  command: string,
  profile: string,
  folder: string | undefined,
  failed: (message: string) => void,
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
    useRemoteViewStore.getState().open({
      ...rest,
      kind: "terminal",
      tabId: result.value.tabId,
      title: command,
    });
  });
}

/** What signs a Codex in on another computer: by a code shown in its terminal. */
const CODEX_SIGN_IN = "codex login --device-auth";

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

/**
 * In place of the controls while the device lets this one only look: the
 * turn's status, and why there is nothing to send with.
 */
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

/** The mode a plan's approval sets (its setMode), of those another device's plan takes. */
function planModeOf(
  updates: readonly unknown[] | undefined,
): "acceptEdits" | "default" | undefined {
  for (const update of updates ?? []) {
    const { type, mode } = (update ?? {}) as { type?: unknown; mode?: unknown };
    if (type === "setMode" && (mode === "acceptEdits" || mode === "default")) return mode;
  }
  return undefined;
}

/**
 * The protocol's answer for the card's. An always-allow keeps the request's
 * suggestions it picked, by their index in the serving computer's list: all
 * of them when it picked none.
 */
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
      // A plan's approval: the mode it goes on in, as the card set it.
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
  /** The device lets this one control its chats; else they are only shown. */
  controls: boolean;
}) {
  const { deviceId, workspaceId, tabId } = target;
  const { read, loadEarlier, loadingEarlier } = usePeerChat(
    { deviceId, workspaceId, tabId },
    visible,
  );
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
        controls={controls}
        selfId={selfId}
      />
    </ChatAgentContext.Provider>
  );
}

/**
 * The chat's goal for its bar. A computer before 0.11.0 tells no end time:
 * one that ended while shown took from when it was set until then; one
 * that had ended before has no time to tell.
 */
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

/** The chat, composer and side panel in the current pane. */
function RemoteChatView({
  target,
  page,
  model,
  older,
  visible,
  reach,
  controls,
  selfId,
}: {
  target: RemoteTarget;
  page: WatchedChat;
  model: ChatModel;
  /** The chat's messages before those read so far. */
  older?: OlderMessages;
  visible: boolean;
  reach: PeerReach;
  controls: boolean;
  selfId?: string;
}) {
  const { t } = useTranslation();
  const { deviceId, workspaceId, tabId } = target;
  const listed = usePeerSessions([deviceId], visible && reach === "online")[deviceId];
  const list = listed?.status === "ready" ? listed.list : undefined;
  const consents = usePeerConsents(deviceId, list?.consents).filter((consent) =>
    consentFromChat(consent, target),
  );
  const consentCards = consents.length
    ? consents.map((consent) => (
        <PeerConsentCard
          key={consent.id}
          consent={controls ? consent : { ...consent, answerable: false }}
          deviceId={deviceId}
          device={target.deviceName}
          workspaceName={
            list?.workspaces.find((workspace) => workspace.id === consent.workspaceId)?.name ??
            consent.workspaceId.slice(0, 8)
          }
        />
      ))
    : null;
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
  const rootRef = useRef<HTMLDivElement>(null);
  // Opened or picked, it takes the keyboard as a chat here does: its permission card, or its box.
  const focusKey = remoteSessionKey(target);
  useEffect(
    () => registerTabFocusTarget(focusKey, () => focusChatTab(rootRef.current)),
    [focusKey],
  );
  const [place, setPlace] = useState<PanelPlace>("beside");
  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry && entry.contentRect.width > 0) setPlace(placeFor(entry.contentRect.width));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const [besideOpen, setBesideOpen] = useState(readPanelPref);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const panelOpen = place === "beside" ? besideOpen : drawerOpen;
  const togglePanel = () => {
    if (place === "beside") {
      writePanelPref(!besideOpen);
      setBesideOpen(!besideOpen);
    } else setDrawerOpen((v) => !v);
  };
  const togglePanelRef = useRef(togglePanel);
  togglePanelRef.current = togglePanel;
  useEffect(() => registerPanelToggle(focusKey, () => togglePanelRef.current()), [focusKey]);
  useEffect(() => {
    if (place === "beside") setDrawerOpen(false);
  }, [place]);
  // The drawer covers the composer, so it takes the keyboard while open, as
  // a chat here's does: Escape closes it from there. Closed, the keyboard
  // goes back to where it was, unless the user put it somewhere else.
  const drawerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const drawer = drawerRef.current;
    if (!drawerOpen || !drawer) return;
    const back = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!drawer.contains(document.activeElement)) drawer.focus({ preventScroll: true });
    return () => {
      const now = document.activeElement;
      const dropped = now === null || now === document.body || drawer.contains(now);
      if (dropped && back?.isConnected) back.focus({ preventScroll: true });
    };
  }, [drawerOpen]);
  // A bare /status, /context or /usage opens the panel; its section opens itself.
  const [panelAsk, setPanelAsk] = useState<RemotePanelAsk | null>(null);
  const askPanel = (part: RemotePanelPart, id?: string) =>
    setPanelAsk((prev) => ({ part, seq: (prev?.seq ?? 0) + 1, ...(id ? { id } : {}) }));
  // biome-ignore lint/correctness/useExhaustiveDependencies: each ask once, where the panel then is
  useEffect(() => {
    if (!panelAsk) return;
    if (place !== "beside") setDrawerOpen(true);
    else if (!besideOpen) {
      writePanelPref(true);
      setBesideOpen(true);
    }
  }, [panelAsk?.seq]);

  // The pane shows main or one subagent's transcript, or a `claude -p` run
  // its session started; input always goes to main.
  const runs = usePeerRuns({ deviceId, workspaceId, tabId }, visible && reach === "online");
  const runRows = useMemo(() => peerRunRows(runs), [runs]);
  const agents = useMemo(
    () => [...remoteAgentsOf(page.panel, model), ...runRows],
    [page.panel, model, runRows],
  );
  const [shownId, setShownId] = useState<string | null>(null);
  const shown = shownId ? agents.find((a) => a.toolUseId === shownId) : undefined;
  useEffect(() => {
    if (shownId && !shown) setShownId(null);
  }, [shownId, shown]);
  const showAgent = (toolUseId: string | null) => {
    setShownId(toolUseId);
    if (place !== "beside") setDrawerOpen(false);
  };

  // ⌘[ and ⌘] step through main and the subagents, as in a chat here.
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;
    if (event.key !== "[" && event.key !== "]") return;
    if (agents.length === 0) return;
    event.preventDefault();
    const order = [null, ...agents.map((a) => a.toolUseId)];
    const at = Math.max(0, order.indexOf(shown ? shown.toolUseId : null));
    const step = event.key === "]" ? 1 : -1;
    setShownId(order[(at + step + order.length) % order.length] ?? null);
  };
  // A task's end in the conversation shows the task: its agent's
  // transcript, or its run in the side panel's background runs.
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
  // A call the side panel asked to see in the conversation, by its id; each ask its own seq.
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
  // Its terminal signs in the chat's profile from 0.13.1; one before signs in its default folder.
  const inProfile = usePeerSpeaks(deviceId, TERMINAL_PROFILE_SCHEMA);
  const hasCodexCommands = usePeerSpeaks(deviceId, "0.13.0");

  // Rewind, fork and background, as a chat here's buttons, where its computer serves them (0.11.0).
  const running = model.running;
  const can = reachable ? page.panel?.can : undefined;
  const [rewinding, setRewinding] = useState<UserItem | null>(null);
  const rewinder = useMemo(
    () => peerRewinder({ deviceId, workspaceId, tabId }),
    [deviceId, workspaceId, tabId],
  );
  const forkFrom = useRef<(itemKey?: string) => void>(() => undefined);
  forkFrom.current = (itemKey) => {
    // A message of the user's comes back with its images.
    const from = itemKey
      ? model.items.find((i) => i.kind === "user" && (i.uuid ?? i.key) === itemKey)
      : undefined;
    void forkPeerChat(target, itemKey, from?.kind === "user" ? from : undefined);
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

  // Where it went on in another of that computer's profiles, by its name there.
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

  // Its images, files and changes are read from that computer, shown in this app's quick look.
  const mediaAccess = usePeerChatAccess(deviceId);
  const loadImage = useMemo(
    () => peerImageLoader({ deviceId, workspaceId, tabId }, mediaAccess, visible),
    [deviceId, workspaceId, tabId, mediaAccess, visible],
  );
  const files = useMemo(
    () => peerChatFiles({ deviceId, workspaceId }, mediaAccess, visible),
    [deviceId, workspaceId, mediaAccess, visible],
  );
  // That computer's workspace, as the previews read it, at its folder there.
  const peerWorkspace = peerWorkspaceId(deviceId, workspaceId);
  useEffect(() => setPeerRoot(peerWorkspace, target.path), [peerWorkspace, target.path]);
  // A file this chat changed is read again by the views showing it.
  usePeerChatFileChanges(peerWorkspace, page.panel?.changedFiles ?? NO_CHANGES, model.tools);
  const [look, setLook] = useState<QuickLookList | null>(null);
  const links = useRemoteLinks(target, { model }, files, setLook);
  // A chat put out of sight takes its quick look with it.
  useEffect(() => {
    if (!visible) setLook(null);
  }, [visible]);

  // The goal, as a chat here shows it over the composer; an ended one closed stays closed.
  const goal = useRemoteGoal(page.panel?.goal, claude ? "claude" : "codex");
  const [, goalClosed] = useReducer((n: number) => n + 1, 0);
  const closedGoal = closedGoals.get(focusKey);
  const closeGoal = (key: string) => {
    closedGoals.set(focusKey, key);
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
    // Claude Code runs /goal clear once the turn ends, which the goal holds off: it stops first.
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
  // As a Codex tab here signs in, in a terminal of its computer, shown here: by a code, as
  // a browser here cannot reach a sign-in that waits there.
  const signInThere = () => runInPeerTerminal(target, CODEX_SIGN_IN);
  const panel = (
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
      className={place === "beside" ? "w-72 shrink-0 border-l border-border" : "h-full"}
    />
  );

  return (
    <ImageLoaderContext.Provider value={loadImage}>
      <ChatFilesContext.Provider value={files}>
        <ChatLinksContext.Provider value={links}>
          {/* The chat's font, as this app's own tabs take it. */}
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
              // A computer that tells its phase starts it again (chat.restart).
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
            <div className="relative flex min-h-0 flex-1">
              <div className="flex min-w-0 flex-1 flex-col">
                {place === "summary" ? (
                  <>
                    <SummaryLine
                      counts={panelSummaryCounts(page.panel, agents)}
                      open={drawerOpen}
                      onToggle={togglePanel}
                    />
                    {shown && (
                      <div className="flex h-7 shrink-0 items-center gap-2 border-b border-border px-2 text-app-ui-sm">
                        <button
                          type="button"
                          onClick={() => showAgent(null)}
                          className="flex shrink-0 items-center gap-1 rounded-(--radius-control) px-1.5 py-0.5 font-medium whitespace-nowrap hover:bg-[var(--state-hover-bg)]"
                        >
                          <ArrowLeft className="size-3.5" aria-hidden />
                          {t("chat.strip.to_main")}
                        </button>
                        <span className="min-w-0 truncate text-muted-foreground">
                          {shown.description}
                        </span>
                        <ShownState agent={shown} />
                      </div>
                    )}
                  </>
                ) : (
                  <AgentStrip
                    agents={agents}
                    shown={shown ? shown.toolUseId : null}
                    onShow={showAgent}
                    panel={{ open: panelOpen, onToggle: togglePanel }}
                  />
                )}
                {shown?.run ? (
                  <RemotePrintRunPane
                    target={target}
                    row={shown.run}
                    visible={visible}
                    controls={reachable}
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
                    reveal={shown ? null : callAsk}
                    {...(moves ? { moves } : {})}
                    {...(older && !shown ? { older } : {})}
                    empty={
                      <div className="my-auto flex flex-col items-center gap-2 py-4 text-center text-muted-foreground">
                        {claude ? (
                          <ClaudeIcon className="size-8" />
                        ) : (
                          <CodexIcon className="size-8" />
                        )}
                        <div className="text-app-body">
                          {t(claude ? "chat.empty.title" : "chat.codex.empty")}
                        </div>
                        <div
                          className="max-w-full truncate font-mono text-app-micro"
                          title={target.cwd ?? target.path}
                        >
                          {target.cwd ?? target.path}
                        </div>
                        {reachable && <RemoteSessionList target={target} />}
                      </div>
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
                    {consentCards && <RemoteRequestDock>{consentCards}</RemoteRequestDock>}
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
                    toMain={shown !== undefined}
                    onShowMain={() => showAgent(null)}
                    goalBar={goalBar}
                    consentCards={consentCards}
                    onPanelPart={askPanel}
                    selfId={selfId}
                  />
                )}
              </div>
              {place === "beside" && besideOpen && panel}
              {place !== "beside" && drawerOpen && (
                <>
                  <button
                    type="button"
                    aria-label={t("chat.panel.hide")}
                    tabIndex={-1}
                    className={cn(
                      "absolute inset-x-0 bottom-0 z-10 cursor-default",
                      place === "summary" ? "top-7" : "top-8",
                    )}
                    onClick={() => setDrawerOpen(false)}
                  />
                  {/* biome-ignore lint/a11y/noStaticElementInteractions: Esc closes the drawer */}
                  <div
                    ref={drawerRef}
                    tabIndex={-1}
                    className={cn(
                      // Below the strip, whose toggle closes it again.
                      "absolute right-0 bottom-0 z-20 border-l border-border bg-background outline-none",
                      place === "summary" ? "top-7 w-full" : "top-8 w-80",
                    )}
                    onKeyDown={(event) => {
                      if (event.key === "Escape") setDrawerOpen(false);
                    }}
                  >
                    {panel}
                  </div>
                </>
              )}
            </div>
            {canRewind && (
              <RewindDialog
                controller={rewinder}
                conversationOnly={!claude}
                item={rewinding}
                cwd={target.cwd ?? target.path}
                onClose={() => setRewinding(null)}
              />
            )}
            {look && (
              <QuickLook
                workspaceId={peerWorkspace}
                peerRoot={target.path}
                list={look}
                area={lookAreaOf(rootRef.current)}
                local={false}
                onIndex={(index) => setLook({ ...look, index })}
                onClose={() => setLook(null)}
                onOpenBeside={(path, { at, before, mode, compare }) => {
                  setLook(null);
                  const key = remoteFileKey({ deviceId, workspaceId, path });
                  useAgentViewStore.getState().placeRemoteFile(key, focusKey, {
                    deviceName: target.deviceName,
                    workspaceRoot: target.path,
                    at: at?.line ? { line: at.line, column: at.column } : undefined,
                    before,
                    mode,
                    compare,
                    compareFrom: before !== undefined ? tabId : undefined,
                  });
                  requestTabFocus(key);
                }}
              />
            )}
          </div>
        </ChatLinksContext.Provider>
      </ChatFilesContext.Provider>
    </ImageLoaderContext.Provider>
  );
}

/** Docked over the composer, so requests are seen wherever the chat is scrolled. */
function RemoteRequestDock({ children }: { children: React.ReactNode }) {
  return (
    <div className="app-scrollbar max-h-[60%] shrink-0 overflow-y-auto px-4 py-2">
      <div className="mx-auto flex max-w-[860px] flex-col gap-2">{children}</div>
    </div>
  );
}

/** What the user answers, stops and writes to the chat with: this app's own card and composer. */
function RemoteControls({
  target,
  model,
  page,
  visible,
  toMain,
  onShowMain,
  goalBar,
  consentCards,
  onPanelPart,
  selfId,
}: {
  target: RemoteTarget;
  selfId?: string;
  model: ChatModel;
  page: WatchedChat;
  visible: boolean;
  /** A subagent's transcript is shown: input still goes to main. */
  toMain: boolean;
  onShowMain: () => void;
  goalBar?: React.ReactNode;
  consentCards: React.ReactNode;
  /** A bare /status, /context or /usage shows the side panel's part, as a chat here's does. */
  onPanelPart?: (part: RemotePanelPart) => void;
}) {
  const { t } = useTranslation();
  const links = useChatLinks();
  const agent = target.kind === "codex" ? "codex" : "claude";
  const { deviceId, workspaceId, tabId } = target;
  const peerTakesPlanMode = usePeerSpeaks(deviceId, "0.13.0");
  const planModeOptions = agent === "claude" && peerTakesPlanMode;
  const folder = target.cwd ?? target.path;
  const types = usePeerTypes(deviceId);
  // Claude's commands run in a terminal there in the chat's profile from 0.13.1; not before.
  const inProfile = usePeerSpeaks(deviceId, TERMINAL_PROFILE_SCHEMA);
  // A Codex chat's /resume and /config, which this pane runs, in its picker as in a Codex tab's.
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
        // Keep Codex's /diff card, with a link to each file's diff.
        if (agent === "codex")
          return changesCard(changed, folder, t, (path) => links?.openChange(path));
        onPanelPart?.("changes");
        return undefined;
      },
      // A computer before 0.13.0 does not run a Codex chat's /status: what this app shows of it.
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
      // Its tab there closed, as /exit closes a chat here: once the user says so, as it is not here.
      exit: () => void closePeerSession(target),
      ...(types && inProfile
        ? {
            terminal: {
              run: (line: string) => runInPeerTerminal(target, line),
              // Its program started again, as the card a chat here shows after /login does.
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
    // The tab /fork or /branch opened there shows, as a fork from a message's does.
    onOpened: (opened, draft) => {
      if (draft) putPeerDraft({ deviceId, workspaceId, tabId: opened }, draft);
      useRemoteViewStore.getState().open({ ...target, tabId: opened, state: "idle" });
    },
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
        ...remoteAnswerOf(given, request, planModeOptions),
      }),
    );
  // /resume's list above the composer, with the words it was given, as a chat here shows it.
  const [resumeQuery, setResumeQuery] = useState<string | null>(null);
  // Its Claude Code settings (/config), and the one a command opened them at, as a chat here has them.
  const [config, setConfig] = useState<{ focus?: string } | null>(null);
  const onCommand = (text: string): boolean => {
    // Its settings (/config), where its computer serves them: a Codex chat's defaults, bare.
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
  // A minute's clock, so a window that resets leaves the line while it shows.
  const now = useNow(visible, 60_000);
  const line = useMemo(() => usageLineOf(page.panel, now), [page.panel, now]);
  const bannerScope = ["remote-chat", deviceId, workspaceId, tabId, page.panel?.session?.id];
  const limit = useMemo(
    () => (target.kind === "codex" ? undefined : rateLimitOf(page.panel, now)),
    [target.kind, page.panel, now],
  );
  const chat =
    target.kind === "codex"
      ? { ...target, kind: "codex" as const }
      : { ...target, kind: "claude" as const };
  return (
    <>
      {(consentCards || model.permissions.length > 0 || model.running || goalBar) && (
        <RemoteRequestDock>
          {goalBar}
          {consentCards}
          {model.permissions.length > 0 && toMain && (
            <div
              className="flex items-center gap-2 rounded-(--radius-control) border border-[var(--state-warning-border)] bg-[var(--state-warning-bg)] px-2 py-1 text-app-ui-sm text-[var(--state-warning-fg)]"
              role="status"
            >
              <span className="min-w-0 flex-1 truncate">{t("chat.strip.permission_waiting")}</span>
              <button
                type="button"
                onClick={onShowMain}
                className="shrink-0 rounded-(--radius-control) px-1.5 py-0.5 font-medium whitespace-nowrap hover:bg-[var(--state-hover-bg)]"
              >
                {t("chat.strip.to_main")}
              </button>
            </div>
          )}
          {model.permissions.length > 0 && !toMain && (
            <PermissionCard
              requests={model.permissions}
              workspaceId={peerWorkspaceId(deviceId, workspaceId)}
              cwd={target.cwd ?? target.path}
              rootPath={target.path}
              planModeOptions={planModeOptions}
              onAnswer={answer}
            />
          )}
          <StatusLine model={model} />
        </RemoteRequestDock>
      )}
      {/* The serving app goes on in it by itself, as it tells (from 0.19.0). */}
      <LimitResumeView scope={bannerScope} record={page.panel?.limitResume} />
      {!showsLimitResume(page.panel?.limitResume) && (
        <RateLimitBanner scope={bannerScope} limit={limit} />
      )}
      <Composer
        controller={composer.controller}
        composition={composition}
        takesDraft={false}
        state={composer.state}
        local={false}
        appCommands={false}
        commands={composer.commands}
        onCommand={onCommand}
        placeholder={
          toMain
            ? t("chat.strip.input_to_main")
            : model.running
              ? // During a turn, what each key does with the message, as a chat here says.
                composerHint(t, true, target.kind === "codex" ? "codex" : "claude")
              : // As a chat here says it, and which computer it goes to.
                t("agentView.remote.placeholder", {
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

/**
 * Another computer's terminal: its screen, typed into where that computer
 * lets this one; and while its Claude Code asks for leave, the request,
 * to answer from here.
 */
function RemoteTerminal({
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
  const read = usePeerTerminal({ deviceId, workspaceId, tabId }, TERMINAL_LINES, visible);
  const types = usePeerTypes(deviceId);
  // Its Claude Code's request is answered as a chat's is: where the computer lets this one control.
  const controls = usePeerControls(deviceId);
  // The request answered here, kept out of sight until the list no longer says it waits.
  const [answered, setAnswered] = useState<string | null>(null);
  // Its state and Claude Code's requests keep updating while the sidebar is hidden.
  const listed = usePeerSessions([deviceId], visible)[deviceId];
  const ask =
    listed?.status === "ready"
      ? (() => {
          const session = listed.list.sessions.find(
            (s) => s.workspaceId === workspaceId && s.tabId === tabId,
          );
          return session ? askOf(session) : undefined;
        })()
      : target.ask;
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
        {...(typing && reach === "online" ? { typing } : {})}
      />
      {reach === "online" && controls && ask && ask.requestId !== answered && (
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
