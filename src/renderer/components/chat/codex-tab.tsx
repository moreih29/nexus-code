import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { defaultProfileId, profileOf } from "../../../shared/agent-profiles/profiles";
import { isUnder } from "../../../shared/fs/relative-path";
import { isExternalSchemeAllowed } from "../../../shared/security/url-scheme";
import { locationLabel } from "../../../shared/types/workspace";
import { useNow } from "../../hooks/use-now";
import { codexTabHooks } from "../../services/chat/agent-tab";
import { parseAppCommand, revealOf } from "../../services/chat/app-commands";
import { pruneAttachmentsOnce } from "../../services/chat/attach-retention";
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
import { goalViewOf } from "../../services/chat/goal";
import { useLocalChatLinks } from "../../services/chat/local-chat-links";
import type { AssistantItem, PermissionRequest, UserItem } from "../../services/chat/model";
import { agentsOf } from "../../services/chat/panel";
import { usePlanCodexLimits } from "../../services/chat/plan-usage";
import {
  printRunRows,
  stopPrintRun,
  useAgentAsk,
  usePrintRuns,
} from "../../services/chat/print-runs";
import { relayedOf, withRelayed } from "../../services/chat/relayed";
import { chatKey, revealPart, useChatStore, useChatTab } from "../../services/chat/store";
import { ChatNotesProvider } from "../../services/notes/chat-notes";
import { chatPanelOf } from "../../services/remote/chat-panel";
import { openTerminal } from "../../services/terminal/open-terminal";
import { queueStartupInput } from "../../services/terminal/pty-client";
import { agentCommandLine } from "../../services/workspace/tasks";
import { openCodexTab } from "../../state/operations/tabs";
import { useAgentProfilesStore } from "../../state/stores/agent-profiles";
import { dropAgentAsk } from "../../state/stores/agent-reveal";
import { useChatFontStyle } from "../../state/stores/chat-font";
import { useGitStore } from "../../state/stores/git";
import type { CodexTabProps } from "../../state/stores/tabs";
import { useWorkspace } from "../../state/stores/workspaces";
import { profileName } from "../agent-profiles/profile-badge";
import { ProfileUsageChip, type TabUse } from "../agent-profiles/tab-profile";
import {
  CodexPanelMcp,
  panelSummaryCounts,
  remotePanelPartOf,
} from "../agent-view/remote-side-panel";
import { ConversationNoteChip } from "../notes/conversation-note-chip";
import { showToast } from "../ui/toast";
import { ChatAgentContext } from "./chat-agent";
import { ChatLinksContext } from "./chat-links";
import {
  ChatEmptyState,
  ChatRequestDock,
  ChatShell,
  codexRateLimitOf,
  LocalChatLook,
  showsEmptyChat,
  useChatPanelPlace,
  useShownAgent,
} from "./chat-shell";
import { ChatPhaseBanner, ChatSignedOutBanner } from "./chat-state-banner";
import { CodexDefaultsDialog } from "./codex-config-dialog";
import { CommandCardView } from "./command-card";
import { Composer } from "./composer";
import { ConversationChildren, ConversationParentChip } from "./conversation-tree";
import { closeGoalBar, GoalBar, useTabGoal } from "./goal-bar";
import { LimitResumeBanner, showsLimitResume } from "./limit-resume-banner";
import { type CallReveal, type MessageActions, MessageList } from "./message-list";
import { PrintRunPane } from "./print-run-pane";
import { RateLimitBanner } from "./rate-limit-banner";
import { RewindDialog } from "./rewind-dialog";
import { surfaceChatSendError } from "./send-error";
import { type InstructionsChipSlot, SessionInstructionsChip } from "./session-instructions-chip";
import { CodexSessionList } from "./session-list";
import { type RemotePanelAsk, type RemotePanelPart, SessionSidePanel } from "./session-side-panel";
import { toolSummary } from "./tool-row";
import { TurnFailureBanner } from "./turn-failure-banner";
import { CodexUsageLine } from "./usage-line";

interface CodexTabViewProps {
  workspaceId: string;
  tabId: string;
  props: CodexTabProps;
  isVisible: boolean;
}

export function CodexTabView({ workspaceId, tabId, props, isVisible }: CodexTabViewProps) {
  const instructions = useCallback(
    (slot: InstructionsChipSlot) => (
      <SessionInstructionsChip workspaceId={workspaceId} tabId={tabId} {...slot} />
    ),
    [workspaceId, tabId],
  );
  const { t } = useTranslation();
  const rootPath = useWorkspace(workspaceId, (w) => w?.rootPath ?? "");
  const location = useWorkspace(workspaceId, (w) => w?.location);
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
  const state = useChatTab(workspaceId, tabId, isVisible);
  const bannerScope = ["chat", workspaceId, tabId, state.model.sessionId];
  const goal = useTabGoal(workspaceId, tabId);
  const model = state.model as CodexModel;
  const steady = useStateBesideStream(state);

  const opened = useRef(false);
  useEffect(() => {
    if (!isVisible || opened.current) return;
    opened.current = true;
    void controller.open();
    pruneAttachmentsOnce(workspaceId);
  }, [isVisible, controller, workspaceId]);

  const onAnswer = (request: PermissionRequest, answer: PermissionAnswer) => {
    void controller.answerPermission(request, answer).catch(surfaceChatSendError);
  };

  const printRuns = usePrintRuns(workspaceId, tabId, isVisible);
  const runs = useMemo(() => printRunRows(printRuns), [printRuns]);
  const agents = useMemo(() => [...agentsOf(steady.model), ...runs], [steady.model, runs]);
  const fontStyle = useChatFontStyle();
  const shell = useChatPanelPlace(tabId, isVisible);
  const { rootRef, place, panelOpen } = shell;
  const {
    shown,
    showAgent: showRun,
    onKeyDown,
  } = useShownAgent(agents, shell, () => dropAgentAsk(tabId));
  useAgentAsk(tabId, agents, showRun);
  const childId = shown && !shown.run ? shown.toolUseId : undefined;
  useEffect(() => {
    if (childId) void controller.loadSubagent(childId);
  }, [childId, controller]);

  const [panelAsk, setPanelAsk] = useState<RemotePanelAsk | null>(null);
  const askPanel = (part: RemotePanelPart) => {
    setPanelAsk((prev) => ({ part, seq: (prev?.seq ?? 0) + 1 }));
    shell.openPanel();
  };
  const [configOpen, setConfigOpen] = useState(false);
  const [resumeQuery, setResumeQuery] = useState<string | null>(null);
  const [resumeError, setResumeError] = useState<string | null>(null);
  const profileId = props.profileId ?? defaultProfileId("codex");
  const collaboration = !!model.collaborationPresets?.plan && !!model.collaborationPresets.default;
  const commands = useMemo(
    () => codexCommandsListed((name) => t(`chat.codex.commands.describe.${name}`), collaboration),
    [t, collaboration],
  );
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
    return controller.continueInProfile(profileId).then(
      () => true,
      (err: Error) => {
        showToast({ kind: "error", message: err.message });
        return false;
      },
    );
  };
  const { items: liveItems, tools: liveTools, agentItems, tasks } = model;
  const source = useMemo(
    () => ({ items: liveItems, tools: liveTools, agentItems }),
    [liveItems, liveTools, agentItems],
  );
  const { links, look, setLook } = useLocalChatLinks({
    workspaceId,
    tabId,
    cwd: props.cwd,
    rootPath,
    visible: isVisible,
    source,
    tasks,
    split: () => shell.place === "beside",
    changesOf: (path) => originalsFor(model.originals, [path]),
  });

  const signIn = () => {
    const command = isLocal ? "codex login" : "codex login --device-auth";
    const { tabId: terminal } = openTerminal({ workspaceId, cwd: props.cwd, profile: profileId });
    queueStartupInput(
      workspaceId,
      terminal,
      (shellPath) => agentCommandLine(command, "", shellPath) ?? "",
    );
  };

  const plan = usePlanCodexLimits(workspaceId, profileId);
  const now = useNow(isVisible, 60_000);
  const rateLimit = useMemo(
    () => codexRateLimitOf(plan ?? model.rateLimits, now),
    [plan, model.rateLimits, now],
  );
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
  const panel = (className: string) => (
    <SessionSidePanel
      scope={{
        agent: "codex",
        foldKey: controller.key,
        workspaceId,
        cwd,
        rootPath,
        computer: (location && locationLabel(location)) ?? t("chat.panel.env.local_computer"),
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
      onShowAgent={showRun}
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
      className={className}
      testId="codex-side-panel"
      conversations={isVisible ? <ConversationChildren tabId={tabId} /> : undefined}
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
  const view = (
    // biome-ignore lint/a11y/noStaticElementInteractions: ⌘[ and ⌘] step through the agents from anywhere in the tab
    <div
      ref={rootRef}
      className="chat-font relative flex h-full flex-col bg-background"
      style={fontStyle}
      data-testid="codex-tab"
      data-chat-drop
      onKeyDown={onKeyDown}
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
      {props.openedBy && <ConversationParentChip opener={props.openedBy} />}
      <ConversationNoteChip />
      <ChatShell
        shell={shell}
        agents={agents}
        shown={shown}
        onShowAgent={showRun}
        summaryCounts={() => panelSummaryCounts(panelData, agents)}
        panel={panel}
      >
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
            itemsDone={shown !== undefined && shown.status !== "running"}
            reveal={callReveal ?? undefined}
            moves={props.moves}
            relayed={relayedOf(props)}
            historyTruncated={!shown && state.truncated}
            empty={
              !shown && showsEmptyChat(state.phase) ? (
                <ChatEmptyState
                  agent="codex"
                  cwd={props.cwd}
                  error={resumeError}
                  onDismissError={() => setResumeError(null)}
                >
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
                </ChatEmptyState>
              ) : null
            }
          />
        )}
        <ChatRequestDock
          model={state.model}
          goal={
            goal && (
              <GoalBar
                tab={goal}
                onClear={() => controller.clearGoal()}
                onStatus={(status) => controller.setGoalStatus(status)}
                onClose={() => closeGoalBar(workspaceId, tabId, goal.goal)}
              />
            )
          }
          card={{ workspaceId, cwd: props.cwd, rootPath, onAnswer }}
          {...(shown ? { onToMain: () => showRun(null) } : {})}
        />
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
        {showsLimitResume(props.limitResume) ? (
          <LimitResumeBanner workspaceId={workspaceId} tabId={tabId} record={props.limitResume} />
        ) : (
          <RateLimitBanner scope={bannerScope} limit={rateLimit} />
        )}
        <TurnFailureBanner
          scope={bannerScope}
          model={model}
          onRetry={(text) => controller.send(text)}
        />
        <Composer
          instructions={instructions}
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
            if (/^\/(config|settings)$/i.test(text.trim())) {
              setConfigOpen(true);
              return true;
            }
            if (parseAppCommand(text, [])?.name === "resume") {
              if (state.model.running) {
                showToast({ kind: "warning", message: t("chat.commands.resume_busy") });
              } else setResumeQuery(text.trim().replace(/^\/\S+\s*/, ""));
              return true;
            }
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
      </ChatShell>
      <CodexDefaultsDialog
        source={controller}
        open={configOpen}
        onClose={() => setConfigOpen(false)}
      />
      <LocalChatLook
        workspaceId={workspaceId}
        tabId={tabId}
        rootPath={rootPath}
        rootRef={rootRef}
        look={look}
        setLook={setLook}
        local={isLocal}
        openFileTab={links.openFileTab}
        agent="codex"
        running={model.running}
      />
    </div>
  );
  return (
    <ChatAgentContext.Provider value="codex">
      <ChatNotesProvider
        workspaceId={workspaceId}
        tabId={tabId}
        agent="codex"
        session={props.threadId}
        visible={isVisible}
      >
        <ChatLinksContext.Provider value={links}>{view}</ChatLinksContext.Provider>
      </ChatNotesProvider>
    </ChatAgentContext.Provider>
  );
}
