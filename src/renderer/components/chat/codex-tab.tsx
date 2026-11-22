// A Codex tab: one Codex thread run by `codex app-server` where the
// workspace runs, shown as a conversation with the list, rows, cards and
// composer of a Claude tab. The program outlives the window and the
// connection, so the view only reads what its controller has. The
// `claude -p` and `codex exec` runs its commands start show beside the
// conversation, in the strip a Claude tab has.

import { ArrowLeft } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { defaultProfileId, profileOf } from "../../../shared/agent-profiles/profiles";
import { isExternalSchemeAllowed } from "../../../shared/security/url-scheme";
import { placeLocalFile, showHeldLocalFile } from "../../services/agent-view/file-tabs";
import { codexTabHooks } from "../../services/chat/agent-tab";
import { parseAppCommand, revealOf } from "../../services/chat/app-commands";
import { useStateBesideStream } from "../../services/chat/beside-stream";
import type { PermissionAnswer } from "../../services/chat/claude/controller";
import { codexCommandsListed, parseCodexCommand } from "../../services/chat/codex/commands";
import { codexController } from "../../services/chat/codex/controller";
import {
  codexHistoryAvailable,
  codexHistoryBusy,
  codexServerVersion,
} from "../../services/chat/codex/history";
import { type CodexModel, originalsFor } from "../../services/chat/codex/model";
import { runCodexCommand } from "../../services/chat/codex/run-command";
import { filesThere } from "../../services/chat/file-presence";
import { goalViewOf } from "../../services/chat/goal";
import {
  imageLook,
  latestReadFile,
  lookAtImage,
  type ShownImage,
} from "../../services/chat/image-look";
import { linkPlaceIndex } from "../../services/chat/link-places";
import {
  type FileLink,
  fileKind,
  isLocalAddress,
  isUnder,
  type LineAt,
} from "../../services/chat/links";
import { lookAreaOf } from "../../services/chat/look-area";
import type { AssistantItem, PermissionRequest, UserItem } from "../../services/chat/model";
import { followFileLink, openBrowserBeside, openFileBeside } from "../../services/chat/open-beside";
import { agentsOf, imagesOf, outsideLinksOf } from "../../services/chat/panel";
import { registerPanelToggle } from "../../services/chat/panel-toggle";
import { usePlanCodexLimits } from "../../services/chat/plan-usage";
import {
  printRunRows,
  stopPrintRun,
  useAgentAsk,
  usePrintRuns,
} from "../../services/chat/print-runs";
import { relayedOf, withRelayed } from "../../services/chat/relayed";
import { revertChangedFile } from "../../services/chat/revert-file";
import { chatKey, revealPart, useChatStore, useChatTab } from "../../services/chat/store";
import { chatPanelOf } from "../../services/remote/chat-panel";
import { registerTabFocusTarget } from "../../services/tab-focus";
import { openTerminal } from "../../services/terminal/open-terminal";
import { queueStartupInput } from "../../services/terminal/pty-client";
import { agentCommandLine } from "../../services/workspace/tasks";
import { localUrlFor } from "../../state/operations/ports";
import { openCodexTab } from "../../state/operations/tabs";
import { useAgentProfilesStore } from "../../state/stores/agent-profiles";
import { dropAgentAsk } from "../../state/stores/agent-reveal";
import { useChatFontStyle } from "../../state/stores/chat-font";
import { useGitStore } from "../../state/stores/git";
import { grantOutside } from "../../state/stores/outside-grants";
import type { CodexTabProps } from "../../state/stores/tabs";
import { useWorkspacesStore } from "../../state/stores/workspaces";
import { cn } from "../../utils/cn";
import { profileName } from "../agent-profiles/profile-badge";
import { ProfileUsageChip, type TabUse } from "../agent-profiles/tab-profile";
import {
  CodexPanelMcp,
  panelSummaryCounts,
  type RemotePanelAsk,
  type RemotePanelPart,
  remotePanelPartOf,
  SessionSidePanel,
} from "../agent-view/remote-side-panel";
import { ConversationNoteChip } from "../notes/conversation-note-chip";
import { BannerDismissButton } from "../ui/banner";
import { showToast } from "../ui/toast";
import { CodexIcon } from "./agent-icons";
import { AgentStrip, ShownState } from "./agent-strip";
import { ChatAgentContext } from "./chat-agent";
import { ChatLinksContext, type LocalChatLinks } from "./chat-links";
import { ChatPhaseBanner, ChatSignedOutBanner } from "./chat-state-banner";
import { CodexDefaultsDialog } from "./codex-config-dialog";
import { CommandCardView } from "./command-card";
import { Composer } from "./composer";
import { closeGoalBar, GoalBar, useTabGoal } from "./goal-bar";
import { LimitResumeBanner } from "./limit-resume-banner";
import { type CallReveal, type MessageActions, MessageList } from "./message-list";
import { type PanelPlace, placeFor, readPanelPref, writePanelPref } from "./panel-place";
import { focusChatTab, PermissionCard } from "./permission-card";
import { PrintRunPane } from "./print-run-pane";
import { QuickLook, type QuickLookList } from "./quick-look";
import { RewindDialog } from "./rewind-dialog";
import { surfaceChatSendError } from "./send-error";
import { CodexSessionList } from "./session-list";
import { StatusLine } from "./status-line";
import { SummaryLine } from "./summary-line";
import { toolSummary } from "./tool-row";
import { TurnFailureBanner } from "./turn-failure-banner";
import { CodexUsageLine } from "./usage-line";

interface CodexTabViewProps {
  workspaceId: string;
  tabId: string;
  props: CodexTabProps;
  isVisible: boolean;
}

/** From this width a file opens in a group beside the tab. */
const SPLIT_FROM_PX = 900;

export function CodexTabView({ workspaceId, tabId, props, isVisible }: CodexTabViewProps) {
  const instructionsTab = useMemo(() => ({ workspaceId, tabId }), [workspaceId, tabId]);
  const { t } = useTranslation();
  const rootPath = useWorkspacesStore(
    (s) => s.workspaces.find((w) => w.id === workspaceId)?.rootPath ?? "",
  );
  const location = useWorkspacesStore(
    (s) => s.workspaces.find((w) => w.id === workspaceId)?.location,
  );
  const isLocal = location?.kind === "local";
  // biome-ignore lint/correctness/useExhaustiveDependencies: the target is read once; the controller keeps the thread it moves on to
  const controller = useMemo(
    () =>
      codexController(
        {
          workspaceId,
          tabId,
          cwd: props.cwd,
          threadId: props.threadId,
          ...(props.fork ? { fork: props.fork } : {}),
          ...(props.profileId ? { profileId: props.profileId } : {}),
          ...(props.chosen ? { chosen: props.chosen } : {}),
        },
        codexTabHooks(workspaceId, tabId),
      ),
    [workspaceId, tabId],
  );
  // Followed while shown: a tab in the background draws nothing per chunk
  // of a streaming reply, and shows the latest when it comes to the front.
  const state = useChatTab(workspaceId, tabId, isVisible);
  const bannerScope = ["chat", workspaceId, tabId, state.model.sessionId];
  const goal = useTabGoal(workspaceId, tabId);
  const model = state.model as CodexModel;
  const steady = useStateBesideStream(state);

  // Opened the first time the tab is shown, so restored tabs in the
  // background start nothing until they are looked at.
  const opened = useRef(false);
  useEffect(() => {
    if (!isVisible || opened.current) return;
    opened.current = true;
    void controller.open();
  }, [isVisible, controller]);

  const onAnswer = (request: PermissionRequest, answer: PermissionAnswer) => {
    void controller.answerPermission(request, answer).catch(surfaceChatSendError);
  };

  // The pane shows the conversation or one of the runs its commands
  // started; input always goes to the conversation.
  const printRuns = usePrintRuns(workspaceId, tabId, isVisible);
  const runs = useMemo(() => printRunRows(printRuns), [printRuns]);
  const agents = useMemo(() => [...agentsOf(steady.model), ...runs], [steady.model, runs]);
  const [shownId, setShownId] = useState<string | null>(null);
  const shown = shownId ? agents.find((run) => run.toolUseId === shownId) : undefined;
  useEffect(() => {
    if (shownId && !shown) setShownId(null);
  }, [shownId, shown]);
  const showRun = (toolUseId: string | null) => {
    setShownId(toolUseId);
    dropAgentAsk(tabId);
  };
  useAgentAsk(tabId, agents, showRun);
  const childId = shown && !shown.run ? shown.toolUseId : undefined;
  useEffect(() => {
    if (childId) void controller.loadSubagent(childId);
  }, [childId, controller]);

  const rootRef = useRef<HTMLDivElement>(null);
  const fontStyle = useChatFontStyle();
  // Brought to the front (its tab picked, the inbox, the agent view), it
  // takes the keyboard.
  useEffect(() => registerTabFocusTarget(tabId, () => focusChatTab(rootRef.current)), [tabId]);
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
    } else setDrawerOpen((open) => !open);
  };
  const togglePanelRef = useRef(togglePanel);
  togglePanelRef.current = togglePanel;
  useEffect(() => registerPanelToggle(tabId, () => togglePanelRef.current()), [tabId]);
  useEffect(() => {
    if (place === "beside" || !isVisible) setDrawerOpen(false);
  }, [place, isVisible]);
  const drawerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const drawer = drawerRef.current;
    if (!drawerOpen || !drawer) return;
    const back = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!drawer.contains(document.activeElement)) drawer.focus({ preventScroll: true });
    return () => {
      const active = document.activeElement;
      if ((active === document.body || drawer.contains(active)) && back?.isConnected) {
        back.focus({ preventScroll: true });
      }
    };
  }, [drawerOpen]);
  const [panelAsk, setPanelAsk] = useState<RemotePanelAsk | null>(null);
  const askPanel = (part: RemotePanelPart) => {
    setPanelAsk((prev) => ({ part, seq: (prev?.seq ?? 0) + 1 }));
    if (place !== "beside") setDrawerOpen(true);
    else if (!besideOpen) {
      writePanelPref(true);
      setBesideOpen(true);
    }
  };
  // What the conversation links opens over the tab, or beside it.
  const [look, setLook] = useState<QuickLookList | null>(null);
  const [configOpen, setConfigOpen] = useState(false);
  // /resume's list above the composer, with the words it was given.
  const [resumeQuery, setResumeQuery] = useState<string | null>(null);
  const [resumeError, setResumeError] = useState<string | null>(null);
  const profileId = props.profileId ?? defaultProfileId("codex");
  // The `/` menu: Codex's commands the tab runs, described in the app's words.
  const collaboration = !!model.collaborationPresets?.plan && !!model.collaborationPresets.default;
  const commands = useMemo(
    () => codexCommandsListed((name) => t(`chat.codex.commands.describe.${name}`), collaboration),
    [t, collaboration],
  );
  // Under the empty conversation a failure shows there; from /resume, as a toast.
  const resumeThread = (
    threadId: string,
    fromProfile: string,
    title: string,
    fail: (message: string) => void = setResumeError,
  ) => {
    setResumeQuery(null);
    setResumeError(null);
    void controller
      .resumeThread(threadId, title, fromProfile)
      .catch((err: Error) => fail(err.message));
  };
  const resumeFailed = (message: string) => {
    showToast({ kind: "error", message: t("chat.sessions.resume_failed", { message }) });
  };
  // What the tab has going decides what another profile offers.
  const tabUse: TabUse = model.running
    ? "running"
    : model.items.length > 0
      ? "conversation"
      : "empty";
  const switchProfile = (profileId: string) => {
    setResumeQuery(null);
    setResumeError(null);
    void controller
      .switchProfile(profileId)
      .catch((err: Error) => showToast({ kind: "error", message: err.message }));
  };
  const continueInProfile = (profileId: string) => {
    setResumeQuery(null);
    setResumeError(null);
    void controller
      .continueInProfile(profileId)
      .catch((err: Error) => showToast({ kind: "error", message: err.message }));
  };
  // A tab put out of sight takes its quick look with it.
  useEffect(() => {
    if (!isVisible) setLook(null);
  }, [isVisible]);
  const [looked, setLooked] = useState<readonly string[]>([]);
  // Taken from the parts it reads, so a line that changes neither does not
  // walk the whole session again.
  const { items: liveItems, tools: liveTools } = state.model;
  const outside = useMemo(
    () => outsideLinksOf(liveItems, liveTools, props.cwd, rootPath, looked),
    [liveItems, liveTools, props.cwd, rootPath, looked],
  );
  useEffect(() => {
    grantOutside(workspaceId, tabId, outside);
  }, [workspaceId, tabId, outside]);
  useEffect(
    () => () => grantOutside(workspaceId, tabId, { files: [], dirs: [] }),
    [workspaceId, tabId],
  );
  const latest = useRef({ state, rootPath, outside });
  latest.current = { state, rootPath, outside };
  // biome-ignore lint/correctness/useExhaustiveDependencies: the tab's state is read from `latest` when a link is followed
  const links = useMemo<LocalChatLinks>(() => {
    const cwd = props.cwd;
    const split = () => (rootRef.current?.clientWidth ?? 0) >= SPLIT_FROM_PX;
    /** Lets the previews read a file outside the workspace the tab grants none of yet. */
    const grant = (path: string) => {
      const { rootPath, outside } = latest.current;
      if (isUnder(path, rootPath) || outside.files.includes(path)) return;
      setLooked((paths) => (paths.includes(path) ? paths : [...paths, path]));
    };
    /** Quick look over the conversation's images, at `target`; `alone` when it is not among them. */
    const lookAt = (target: ShownImage, alone?: () => QuickLookList) => {
      const current = latest.current.state.model as CodexModel;
      const shown = imagesOf(current.items, current.tools, cwd, current.agentItems);
      const held = target.image ? latestReadFile(shown, target) : undefined;
      if (held && showHeldLocalFile(workspaceId, held)) {
        setLook(null);
        return;
      }
      void lookAtImage(shown, target, (files) =>
        filesThere(workspaceId, latest.current.rootPath, files),
      ).then((look) => {
        for (const path of Object.values(look?.paths ?? {})) grant(path);
        const list = look ?? alone?.();
        if (list) setLook(list);
      });
    };
    /** Shows a file alone, as a diff when the session changed it and the agent kept its original. */
    const showAlone = (path: string, line?: LineAt) => {
      const current = latest.current.state.model as CodexModel;
      setLook({
        files: [path],
        index: 0,
        changes: originalsFor(current.originals, [path]),
        ...(line?.line ? { at: { path, line: line.line, column: line.column } } : {}),
      });
    };
    /**
     * The file a link names, and where in it, once it is known which file
     * that is: from the tab's folder, or from where the agent's shell went.
     */
    const follow = (target: string, then: (link: FileLink) => void) => {
      const { state, rootPath } = latest.current;
      const places = linkPlaceIndex(state.model.tools, cwd);
      void followFileLink(workspaceId, rootPath, target, places).then((link) => link && then(link));
    };
    const openFileTab = (target: string, at?: LineAt) => {
      follow(target, ({ path, ...line }) => {
        const inside = isUnder(path, latest.current.rootPath);
        openFileBeside(workspaceId, tabId, path, { split: split(), inside, at: at ?? line });
      });
    };
    return {
      openFile(target) {
        follow(target, ({ path, ...line }) => {
          grant(path);
          if (showHeldLocalFile(workspaceId, path, line)) {
            setLook(null);
            return;
          }
          // An image steps through the conversation's images; any other file shows alone.
          if (fileKind(path) !== "image") return showAlone(path, line);
          lookAt({ file: path });
        });
      },
      openChange(path) {
        grant(path);
        if (showHeldLocalFile(workspaceId, path)) setLook(null);
        else showAlone(path);
      },
      openImages(images, index) {
        const image = images[index];
        if (image) lookAt({ image }, () => imageLook(images, index));
      },
      openFileTab,
      openUrl(url, other = false) {
        const local = isLocalAddress(url);
        if (local !== other) {
          openBrowserBeside(workspaceId, tabId, url, { split: split() });
        } else if (local) {
          void localUrlFor(workspaceId, url).then((here) => {
            if (here) window.open(here, "_blank", "noopener,noreferrer");
          });
        } else if (isExternalSchemeAllowed(url)) {
          window.open(url, "_blank", "noopener,noreferrer");
        }
      },
    };
  }, [workspaceId, tabId]);

  const signIn = () => {
    // A browser on this machine cannot reach a sign-in an SSH host waits for.
    const command = isLocal ? "codex login" : "codex login --device-auth";
    // In the tab's profile: in another, `codex login` would sign the default folder out.
    const { tabId: terminal } = openTerminal({ workspaceId, cwd: props.cwd, profile: profileId });
    queueStartupInput(
      workspaceId,
      terminal,
      (shellPath) => agentCommandLine(command, "", shellPath) ?? "",
    );
  };

  const plan = usePlanCodexLimits(workspaceId, profileId);
  const branch = useGitStore((s) => {
    const git = s.sessions.get(workspaceId);
    return git?.branchInfo?.current ?? git?.status?.branch?.current ?? null;
  });
  const profileConfig = useAgentProfilesStore((s) => s.config);
  const profile = profileOf(profileConfig, "codex", profileId);
  const panelData = useMemo(
    () =>
      panelOpen || place === "summary"
        ? chatPanelOf({ agent: "codex", title: "", chat: steady, plan: { codex: plan } })
        : undefined,
    [panelOpen, place, steady, plan],
  );
  const [callReveal, setCallReveal] = useState<CallReveal | null>(null);
  const showCall = (toolUseId: string) => {
    showRun(null);
    setDrawerOpen(false);
    setCallReveal((prev) => ({ toolUseId, seq: (prev?.seq ?? 0) + 1 }));
  };
  const ready = state.phase === "ready" && model.process === "running";
  const threadId = model.threadId;
  const [signingIn, setSigningIn] = useState<{
    name: string;
    threadId?: string;
    afterSeq: number;
  } | null>(null);
  const login = model.mcpLogin;
  useEffect(() => {
    if (!signingIn) return;
    if (signingIn.threadId !== threadId || !ready) {
      setSigningIn(null);
      return;
    }
    if (!login || login.seq <= signingIn.afterSeq || login.name !== signingIn.name) return;
    setSigningIn(null);
    if (!login.success) {
      showToast({
        kind: "error",
        message: login.error ?? t("chat.panel.mcp.login_failed", { name: login.name }),
      });
    }
  }, [signingIn, threadId, ready, login, t]);
  const mcpSignIn = async (name: string) => {
    setSigningIn({ name, threadId, afterSeq: model.lastSeq });
    try {
      const result = await controller.ask("mcpServer/oauth/login", {
        name,
        ...(threadId ? { threadId } : {}),
      });
      if (
        typeof result.authorizationUrl !== "string" ||
        !/^https?:\/\//i.test(result.authorizationUrl) ||
        !isExternalSchemeAllowed(result.authorizationUrl)
      ) {
        throw new Error(t("chat.panel.mcp.login_failed", { name }));
      }
      window.open(result.authorizationUrl, "_blank", "noopener,noreferrer");
    } catch (error) {
      setSigningIn(null);
      throw error;
    }
  };
  const runCommand = (command: { name: string; args: string }) => {
    const { history, model } = state;
    return runCodexCommand(command, {
      controller,
      workspaceId,
      tabId,
      cwd: props.cwd,
      rootPath,
      ...(props.profileId ? { profileId: props.profileId } : {}),
      items: withRelayed(
        history ? [...history.items, ...model.items] : model.items,
        relayedOf(props),
      ),
      tools: history ? { ...history.tools, ...model.tools } : model.tools,
      summarize: (tool) => toolSummary(tool, props.cwd),
      openFileTab: links.openFileTab,
    });
  };
  const cwd = model.cwd ?? props.cwd;
  const refreshMcp = async () => {
    await controller.listMcpServers();
  };
  const panelGoal = goalViewOf(model);
  const historyBusy = codexHistoryBusy(state);
  const panel = (
    <SessionSidePanel
      scope={{
        agent: "codex",
        foldKey: controller.key,
        workspaceId,
        cwd,
        rootPath,
        computer:
          location?.kind === "ssh"
            ? (location.configAlias ?? location.host)
            : location?.kind === "wsl"
              ? location.distro
              : t("chat.panel.env.local_computer"),
        profile: profileName(profile, t),
      }}
      panel={panelData}
      model={steady.model}
      runs={runs}
      controls
      goal={
        panelGoal
          ? { goal: panelGoal, running: model.running, startedAt: model.turn?.startedAt }
          : null
      }
      reveal={panelAsk}
      signedOut={model.account === null}
      branch={isUnder(cwd, rootPath) ? branch : null}
      contextUsed={model.tokens?.used}
      onShowAgent={(id) => {
        showRun(id);
        setDrawerOpen(false);
      }}
      onShowCall={showCall}
      onCompact={
        ready && threadId && !model.signedOut
          ? () => runCommand({ name: "compact", args: "" })
          : undefined
      }
      onStopRun={(runId) => void stopPrintRun(workspaceId, tabId, runId)}
      onForkSession={
        threadId && model.items.length > 0 && !historyBusy
          ? () =>
              void runCommand({ name: "fork", args: "" }).catch((err: Error) =>
                showToast({ kind: "error", message: err.message }),
              )
          : undefined
      }
      onRefreshAccount={ready ? () => controller.refreshAccount() : undefined}
      mcp={
        <CodexPanelMcp
          key={threadId}
          servers={panelData?.mcp}
          onRefresh={ready ? refreshMcp : undefined}
          onReload={
            ready && !model.running
              ? async () => {
                  if (controller.model.running) throw new Error(t("chat.codex.commands.busy"));
                  await controller.ask("config/mcpServer/reload");
                  await refreshMcp();
                }
              : undefined
          }
          onSignIn={ready && isLocal ? mcpSignIn : undefined}
          signInNames={model.mcpServers
            ?.filter((server) => server.needsLogin)
            .map((server) => server.name)}
          signingIn={signingIn?.name}
          refreshKey={ready ? login?.seq : undefined}
          reveal={panelAsk?.part === "mcp" ? panelAsk.seq : undefined}
        />
      }
      className={place === "beside" ? "w-72 shrink-0 border-l border-border" : "h-full"}
      testId="codex-side-panel"
    />
  );

  const [rewinding, setRewinding] = useState<UserItem | null>(null);
  const historyAvailable = codexHistoryAvailable(codexServerVersion(model, state.version));
  const forkFrom = (item: UserItem | AssistantItem) => {
    try {
      const fork = controller.forkPoint(item);
      const tab = openCodexTab(workspaceId, {
        cwd: props.cwd,
        fork,
        profileId,
        chosen: controller.inheritedChoice(),
        ...controller.inheritedInstructions(),
      });
      if (item.kind === "user") {
        const draft = { text: item.text, images: item.images, nonce: Date.now() };
        useChatStore
          .getState()
          .update(chatKey(workspaceId, tab.id), (prev) => ({ ...prev, draft }));
      }
    } catch (error) {
      showToast({ kind: "error", message: (error as Error).message });
    }
  };
  const messageActions: MessageActions | undefined =
    historyAvailable && !shown
      ? {
          running: historyBusy,
          canFork: !historyBusy,
          canForkItem: (item) => !historyBusy && item.forkable === true,
          canRewindItem: (item) => item.rewindable === true,
          onFork: forkFrom,
          onRewind: setRewinding,
        }
      : undefined;
  const permissions = model.permissions;
  const view = (
    <div
      ref={rootRef}
      className="chat-font relative flex h-full flex-col bg-background"
      style={fontStyle}
      data-testid="codex-tab"
      data-chat-drop
    >
      {rewinding && (
        <RewindDialog
          controller={controller}
          item={rewinding}
          cwd={props.cwd}
          conversationOnly
          onClose={() => setRewinding(null)}
        />
      )}
      <ChatPhaseBanner
        scope={bannerScope}
        status={{
          agent: "codex",
          process: state.model.process,
          phase: state.phase,
          error: state.error,
          version: state.version,
          exit: state.model.exit,
          phaseRevision: state.phaseRevision,
        }}
        onRestart={() => void controller.restart()}
        onRetry={() => void controller.open()}
        className="shrink-0 pt-1"
      />
      <ChatSignedOutBanner
        scope={bannerScope}
        status={{ agent: "codex", process: model.process, signedOut: model.signedOut }}
        onSignIn={signIn}
        onCheck={() => void controller.refreshAccount()}
      />
      <ConversationNoteChip
        workspaceId={workspaceId}
        tabId={tabId}
        agent="codex"
        session={props.threadId}
        visible={isVisible}
      />
      <div className="relative flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          {place === "summary" ? (
            <>
              <SummaryLine
                counts={panelSummaryCounts(panelData, agents)}
                open={drawerOpen}
                onToggle={togglePanel}
              />
              {shown && (
                <div className="flex h-7 shrink-0 items-center gap-2 border-b border-border px-2 text-app-ui-sm">
                  <button
                    type="button"
                    onClick={() => showRun(null)}
                    className="flex shrink-0 items-center gap-1 rounded-(--radius-control) px-1.5 py-0.5 font-medium hover:bg-[var(--state-hover-bg)]"
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
              agents={runs}
              shown={shown ? shown.toolUseId : null}
              onShow={showRun}
              panel={{ open: panelOpen, onToggle: togglePanel }}
            />
          )}
          {shown?.run ? (
            <PrintRunPane
              workspaceId={workspaceId}
              tabId={tabId}
              cwd={props.cwd}
              rootPath={rootPath}
              run={shown.run}
              visible={isVisible}
            />
          ) : (
            <MessageList
              workspaceId={workspaceId}
              tabId={tabId}
              cwd={props.cwd}
              rootPath={rootPath}
              history={null}
              model={state.model}
              actions={messageActions}
              items={childId ? (model.nativeTranscripts?.[childId] ?? []) : undefined}
              reveal={callReveal ?? undefined}
              moves={props.moves}
              relayed={relayedOf(props)}
              historyTruncated={!shown && state.truncated}
              empty={
                !shown && (state.phase === "ready" || state.phase === "ended") ? (
                  <div className="my-auto flex flex-col items-center gap-2 py-4 text-center text-muted-foreground">
                    <CodexIcon className="size-8" />
                    <div className="text-app-body">{t("chat.codex.empty")}</div>
                    <div className="max-w-full truncate font-mono text-app-micro" title={props.cwd}>
                      {props.cwd}
                    </div>
                    {resumeError && (
                      <div className="flex items-center gap-2 text-app-ui-sm text-[var(--state-error-fg)]">
                        <span className="flex-1">
                          {t("chat.sessions.resume_failed", { message: resumeError })}
                        </span>
                        <BannerDismissButton
                          dismiss={{
                            label: t("action.dismiss"),
                            onDismiss: () => setResumeError(null),
                          }}
                        />
                      </div>
                    )}
                    {state.phase === "ready" && (
                      <CodexSessionList
                        workspaceId={workspaceId}
                        tabId={tabId}
                        controller={controller}
                        cwd={props.cwd}
                        profileId={profileId}
                        onResume={resumeThread}
                      />
                    )}
                  </div>
                ) : null
              }
            />
          )}
          {(permissions.length > 0 || model.running || goal) && (
            <div className="app-scrollbar max-h-[60%] shrink-0 overflow-y-auto px-4 py-2">
              <div className="mx-auto flex max-w-[860px] flex-col gap-2">
                {goal && (
                  <GoalBar
                    tab={goal}
                    onClear={() => controller.clearGoal()}
                    onStatus={(status) => controller.setGoalStatus(status)}
                    onClose={() => closeGoalBar(workspaceId, tabId, goal.goal)}
                  />
                )}
                {permissions.length > 0 && (
                  <PermissionCard
                    requests={permissions}
                    workspaceId={workspaceId}
                    cwd={props.cwd}
                    rootPath={rootPath}
                    onAnswer={onAnswer}
                  />
                )}
                <StatusLine model={state.model} />
              </div>
            </div>
          )}
          {model.collaborationMode === "plan" && collaboration && (
            <div className="mx-auto flex w-full max-w-[860px] px-4">
              <button
                type="button"
                className="rounded-(--radius-control) px-2 py-1 text-app-ui-sm text-accent-foreground hover:bg-accent"
                title={t("chat.codex.commands.describe.default")}
                aria-label={t("chat.codex.commands.describe.default")}
                onClick={() => {
                  void runCommand({ name: "default", args: "" }).catch((error: Error) =>
                    showToast({ kind: "error", message: error.message }),
                  );
                }}
              >
                {t("chat.codex.commands.collaboration.plan")}
              </button>
            </div>
          )}
          <LimitResumeBanner workspaceId={workspaceId} tabId={tabId} record={props.limitResume} />
          <TurnFailureBanner
            scope={bannerScope}
            model={model}
            onRetry={(text) => controller.send(text)}
          />
          <Composer
            instructionsTab={instructionsTab}
            controller={controller}
            state={state}
            relayed={relayedOf(props)}
            local={isLocal}
            commands={commands}
            placeholder={shown ? t("chat.strip.input_to_main") : undefined}
            above={
              resumeQuery !== null ? (
                <CodexSessionList
                  workspaceId={workspaceId}
                  tabId={tabId}
                  controller={controller}
                  cwd={props.cwd}
                  profileId={profileId}
                  query={resumeQuery}
                  onClose={() => setResumeQuery(null)}
                  onResume={(threadId, profile, title) =>
                    resumeThread(threadId, profile, title, resumeFailed)
                  }
                />
              ) : (
                state.card && (
                  <CommandCardView
                    card={state.card}
                    workspaceId={workspaceId}
                    cwd={props.cwd}
                    rootPath={rootPath}
                    onClose={() => controller.closeCard()}
                  />
                )
              )
            }
            below={
              <CodexUsageLine
                workspaceId={workspaceId}
                profileId={props.profileId}
                visible={isVisible}
                tokens={model.tokens}
                rateLimits={model.rateLimits}
                trailing={(compact) => (
                  <ProfileUsageChip
                    agent="codex"
                    workspaceId={workspaceId}
                    profileId={props.profileId}
                    use={tabUse}
                    onSwitch={switchProfile}
                    onContinue={continueInProfile}
                    compact={compact}
                  />
                )}
              />
            }
            onCommand={(text) => {
              // A bare /config (or /settings) opens the defaults.
              if (/^\/(config|settings)$/i.test(text.trim())) {
                setConfigOpen(true);
                return true;
              }
              // /resume lists the folder's threads, to go on with one here.
              if (parseAppCommand(text, [])?.name === "resume") {
                if (state.model.running) {
                  showToast({ kind: "warning", message: t("chat.commands.resume_busy") });
                } else setResumeQuery(text.trim().replace(/^\/\S+\s*/, ""));
                return true;
              }
              // A bare /model or /effort opens its menu, as Codex's own does.
              const part = revealOf(text, ["model", "effort"]);
              if (part) {
                revealPart(controller.key, part);
                return true;
              }
              const section = remotePanelPartOf(text);
              if (section) {
                askPanel(section);
                return true;
              }
              const command = parseCodexCommand(text);
              if (!command || ["config", "resume"].includes(command.name)) return false;
              void runCommand(command).catch((err: Error) =>
                showToast({ kind: "error", message: err.message }),
              );
              return true;
            }}
          />
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
            {/* biome-ignore lint/a11y/noStaticElementInteractions: Escape closes the drawer */}
            <div
              ref={drawerRef}
              tabIndex={-1}
              className={cn(
                "absolute right-0 bottom-0 z-20 border-l border-border bg-background outline-none",
                place === "summary" ? "top-7 w-full" : "top-8 w-80",
              )}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.stopPropagation();
                  setDrawerOpen(false);
                }
              }}
            >
              {panel}
            </div>
          </>
        )}
      </div>
      <CodexDefaultsDialog
        source={controller}
        open={configOpen}
        onClose={() => setConfigOpen(false)}
      />
      {look && (
        <QuickLook
          workspaceId={workspaceId}
          list={look}
          area={lookAreaOf(rootRef.current)}
          local={isLocal}
          onIndex={(index) => setLook({ ...look, index })}
          onClose={() => setLook(null)}
          onOpenBeside={(path, { at }) => {
            setLook(null);
            placeLocalFile(workspaceId, tabId, path, isUnder(path, rootPath), at);
          }}
          onOpenTab={(path, at) => {
            setLook(null);
            links.openFileTab(path, at);
          }}
          onRevert={(path) => {
            const before = look.changes?.[path];
            if (before !== undefined) {
              void revertChangedFile(workspaceId, rootPath, path, before, "codex");
            }
          }}
          revertBlocked={
            model.running ? t("chat.look.revert_busy", { context: "codex" }) : undefined
          }
        />
      )}
    </div>
  );
  return (
    <ChatAgentContext.Provider value="codex">
      <ChatLinksContext.Provider value={links}>{view}</ChatLinksContext.Provider>
    </ChatAgentContext.Provider>
  );
}
