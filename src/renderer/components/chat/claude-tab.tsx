import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useBannerDismissal } from "../../hooks/use-banner-dismissal";
import { useStableHandlers } from "../../hooks/use-stable-handlers";
import { claudeTabHooks } from "../../services/chat/agent-tab";
import { parseAppCommand, revealOf } from "../../services/chat/app-commands";
import { pruneAttachmentsOnce } from "../../services/chat/attach-retention";
import { useStateBesideStream } from "../../services/chat/beside-stream";
import { configCommandOf } from "../../services/chat/claude/config";
import {
  type ChatController,
  chatController,
  type PermissionAnswer,
} from "../../services/chat/claude/controller";
import { historyForDisplay } from "../../services/chat/claude/history";
import {
  borrowedClaudeModels,
  useClaudeModelCatalog,
} from "../../services/chat/claude/model-catalog";
import { runAppCommand } from "../../services/chat/claude/run-command";
import { type ChangesOf, useLocalChatLinks } from "../../services/chat/local-chat-links";
import type { AssistantItem, PermissionRequest, UserItem } from "../../services/chat/model";
import { revealTabById } from "../../services/chat/open-beside";
import {
  agentsOf,
  agentTranscript,
  changedFilesOf,
  jobsOf,
  joinAgents,
  pastAgentsOf,
} from "../../services/chat/panel";
import {
  printRunRows,
  stopPrintRun,
  useAgentAsk,
  usePrintRuns,
} from "../../services/chat/print-runs";
import { relayedOf, withRelayed } from "../../services/chat/relayed";
import { jobToolStatuses } from "../../services/chat/running";
import {
  type ComposerDraft,
  chatKey,
  type RevealPart,
  revealPart,
  useChatStore,
  useChatTab,
} from "../../services/chat/store";
import { useTerminalTwin } from "../../services/chat/terminal-twin";
import { ChatNotesProvider } from "../../services/notes/chat-notes";
import { openClaudeTab } from "../../state/operations/tabs";
import { dropAgentAsk } from "../../state/stores/agent-reveal";
import { useChatFontStyle } from "../../state/stores/chat-font";
import type { ClaudeTabProps } from "../../state/stores/tabs";
import { useTabsStore } from "../../state/stores/tabs";
import { useWorkspace } from "../../state/stores/workspaces";
import { ProfileUsageChip, type TabUse } from "../agent-profiles/tab-profile";
import { ConversationNoteChip } from "../notes/conversation-note-chip";
import { Banner } from "../ui/banner";
import { showToast } from "../ui/toast";
import { ChatLinksContext } from "./chat-links";
import {
  ChatEmptyState,
  ChatRequestDock,
  ChatShell,
  LocalChatLook,
  showsEmptyChat,
  useChatPanelPlace,
  useShownAgent,
} from "./chat-shell";
import { ChatPhaseBanner } from "./chat-state-banner";
import { CommandCardView } from "./command-card";
import { Composer } from "./composer";
import { ConfigDialog } from "./config-dialog";
import { ConversationParentChip } from "./conversation-tree";
import { closeGoalBar, GoalBar, useTabGoal } from "./goal-bar";
import { LimitResumeBanner, showsLimitResume } from "./limit-resume-banner";
import { type CallReveal, type MessageActions, MessageList } from "./message-list";
import { PrintRunPane } from "./print-run-pane";
import { RateLimitBanner } from "./rate-limit-banner";
import { RewindDialog } from "./rewind-dialog";
import { surfaceChatSendError } from "./send-error";
import { type InstructionsChipSlot, SessionInstructionsChip } from "./session-instructions-chip";
import { SessionList } from "./session-list";
import { SidePanel } from "./side-panel";
import { summaryCountsOf } from "./summary-line";
import { toolSummary } from "./tool-row";
import { TurnFailureBanner } from "./turn-failure-banner";
import { ClaudeUsageLine } from "./usage-line";

interface ClaudeTabViewProps {
  workspaceId: string;
  tabId: string;
  props: ClaudeTabProps;
  isVisible: boolean;
}

const PANEL_PARTS: ReadonlySet<RevealPart> = new Set(["context", "usage", "mcp", "status", "jobs"]);

export function ClaudeTabView({ workspaceId, tabId, props, isVisible }: ClaudeTabViewProps) {
  const instructions = useCallback(
    (slot: InstructionsChipSlot) => (
      <SessionInstructionsChip workspaceId={workspaceId} tabId={tabId} {...slot} />
    ),
    [workspaceId, tabId],
  );
  const { t } = useTranslation();
  const rootPath = useWorkspace(workspaceId, (w) => w?.rootPath ?? "");
  const isLocal = useWorkspace(workspaceId, (w) => w?.location.kind === "local");
  // biome-ignore lint/correctness/useExhaustiveDependencies: the target is read once; the controller keeps the session it moves on to
  const controller = useMemo(
    () =>
      chatController(
        {
          workspaceId,
          tabId,
          cwd: props.cwd,
          sessionId: props.sessionId,
          fork: props.fork,
          ...(props.profileId ? { profileId: props.profileId } : {}),
          ...(props.moves ? { moves: props.moves } : {}),
          ...(props.chosen ? { chosen: props.chosen } : {}),
        },
        claudeTabHooks(workspaceId, tabId),
      ),
    [workspaceId, tabId],
  );
  const state = useChatTab(workspaceId, tabId, isVisible);
  const bannerScope = ["chat", workspaceId, tabId, state.model.sessionId];
  const steady = useStateBesideStream(state);
  const modelCatalogKey =
    isVisible && !steady.model.init?.models.length ? controller.modelCatalogKey : undefined;
  const fallbackModels = useClaudeModelCatalog((catalog) =>
    modelCatalogKey ? borrowedClaudeModels(catalog, modelCatalogKey, controller.key) : undefined,
  );
  const goal = useTabGoal(workspaceId, tabId);

  const lineReady = state.phase === "ready" && state.model.process === "running";
  useEffect(() => {
    if (isVisible && lineReady) controller.refreshUsageLine();
  }, [controller, isVisible, lineReady]);

  const opened = useRef(false);
  useEffect(() => {
    if (!isVisible || opened.current) return;
    opened.current = true;
    void controller.open();
    pruneAttachmentsOnce(workspaceId);
  }, [isVisible, controller, workspaceId]);

  const customTitle = useTabsStore((s) => s.byWorkspace[workspaceId]?.[tabId]?.customTitle);
  const named = useRef(customTitle);
  useEffect(() => {
    controller.keepName(customTitle);
    if (customTitle === named.current) return;
    named.current = customTitle;
    if (customTitle) void controller.renameSession(customTitle).catch(() => {});
  }, [customTitle, controller]);

  const [resumeError, setResumeError] = useState<string | null>(null);
  const resumeSession = (
    sessionId: string,
    profileId?: string,
    fail: (message: string) => void = setResumeError,
  ) => {
    setResumeError(null);
    void controller.resumeSession(sessionId, profileId).catch((err: Error) => fail(err.message));
  };
  const tabUse: TabUse = state.model.running
    ? "running"
    : (state.history?.items.length ?? 0) > 0 || state.model.items.length > 0
      ? "conversation"
      : "empty";
  const switchProfile = (profileId: string) => {
    setResumeError(null);
    void controller
      .switchProfile(profileId)
      .catch((err: Error) => showToast({ kind: "error", message: err.message }));
  };
  const continueInProfile = (profileId: string) => {
    setResumeError(null);
    void controller
      .continueInProfile(profileId)
      .catch((err: Error) => showToast({ kind: "error", message: err.message }));
  };
  const resumeFailed = (message: string) => {
    showToast({ kind: "error", message: t("chat.sessions.resume_failed", { message }) });
  };

  const onAnswer = (request: PermissionRequest, answer: PermissionAnswer) => {
    void controller.answerPermission(request, answer).catch(surfaceChatSendError);
  };

  const [rewinding, setRewinding] = useState<{
    item: UserItem;
    sessionId: string | undefined;
    clears: number | undefined;
  } | null>(null);
  if (
    rewinding &&
    (rewinding.sessionId !== controller.currentSession() || rewinding.clears !== state.model.clears)
  ) {
    setRewinding(null);
  }
  const running = state.model.running;
  const canFork = controller.forkPoint("", { before: false }) !== null;
  const asking = state.model.permissions;
  const unverifiedStart = controller.unverifiedHistoryStart();
  const taskShower = useRef<NonNullable<MessageActions["taskShower"]>>(() => undefined);
  const actions = useMemo<MessageActions>(
    () => ({
      running,
      canFork,
      canForkItem: (item) =>
        !!item.uuid &&
        (item.kind !== "user" || (item.state === "taken" && item.uuid !== unverifiedStart)),
      canRewindItem: (item) =>
        item.state === "taken" && !!item.uuid && item.uuid !== unverifiedStart,
      onRewind: (item) =>
        setRewinding({
          item,
          sessionId: controller.currentSession(),
          clears: controller.state.model.clears,
        }),
      onFork: (item) => forkFrom(controller, workspaceId, props.cwd, item),
      onBackground: (toolUseId) => backgroundCall(controller, toolUseId),
      waiting: new Set(asking.flatMap((p) => (p.toolUseId ? [p.toolUseId] : []))),
      taskShower: (item) => taskShower.current(item),
    }),
    [running, canFork, controller, workspaceId, props.cwd, asking, unverifiedStart],
  );

  const fontStyle = useChatFontStyle();
  const shell = useChatPanelPlace(tabId, isVisible);
  const { rootRef } = shell;
  const reveal = state.reveal;
  // biome-ignore lint/correctness/useExhaustiveDependencies: each ask once, where the panel then is
  useEffect(() => {
    if (reveal && PANEL_PARTS.has(reveal.part)) shell.openPanel();
  }, [reveal?.seq]);

  const printRuns = usePrintRuns(workspaceId, tabId, isVisible);
  const runRows = useMemo(() => printRunRows(printRuns), [printRuns]);
  const pastHistory = state.history;
  const pastModel = useMemo(
    () => (pastHistory ? historyForDisplay(pastHistory) : null),
    [pastHistory],
  );
  const { tasks: agentTasks, tools: agentTools, agentItems, items: agentCalls } = state.model;
  const pastAgents = useMemo(() => (pastModel ? pastAgentsOf(pastModel) : []), [pastModel]);
  const liveAgents = useMemo(
    () => agentsOf({ tasks: agentTasks, tools: agentTools, agentItems, items: agentCalls }),
    [agentTasks, agentTools, agentItems, agentCalls],
  );
  const agents = useMemo(
    () => joinAgents(pastAgents, liveAgents, runRows),
    [pastAgents, liveAgents, runRows],
  );
  const { shown, showAgent, onKeyDown } = useShownAgent(agents, shell, () => dropAgentAsk(tabId));
  const pastAgentItems = pastModel?.agentItems;
  const shownWrote = shown
    ? (agentItems[shown.toolUseId] ?? pastAgentItems?.[shown.toolUseId])
    : undefined;
  const shownTranscript = useMemo(
    () =>
      shown && !shown.run
        ? agentTranscript(
            { agentItems: shownWrote ? { [shown.toolUseId]: shownWrote } : {} },
            shown,
          )
        : undefined,
    [shown, shownWrote],
  );
  const unread =
    shown && !shown.run && shown.status !== "running" && !shownWrote ? shown.toolUseId : null;
  useEffect(() => {
    if (unread) void controller.loadSubagent(unread);
  }, [controller, unread]);
  useAgentAsk(tabId, agents, showAgent);
  taskShower.current = (item) => {
    const task = state.model.tasks[item.taskId];
    const toolUseId = task?.toolUseId ?? item.toolUseId;
    if (toolUseId && agents.some((a) => a.toolUseId === toolUseId)) {
      return () => showAgent(toolUseId);
    }
    return task && jobsOf(state.model).includes(task)
      ? () => revealPart(controller.key, "jobs", item.taskId)
      : undefined;
  };
  const [callAsk, setCallAsk] = useState<CallReveal | null>(null);
  const showCall = (toolUseId: string) => {
    showAgent(null);
    setCallAsk((prev) => ({ toolUseId, seq: (prev?.seq ?? 0) + 1 }));
  };

  const history = state.history;
  const { items: liveItems, tools: liveTools, tasks } = state.model;
  const toolStatuses = useMemo(
    () => jobToolStatuses({ tasks, tools: liveTools, running }),
    [tasks, liveTools, running],
  );
  const source = useMemo(
    () => ({
      items: history ? [...history.items, ...liveItems] : liveItems,
      tools: history ? { ...history.tools, ...liveTools } : liveTools,
      agentItems: state.model.agentItems,
    }),
    [history, liveItems, liveTools, state.model.agentItems],
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
    changesOf: claudeChangesOf,
  });

  const [config, setConfig] = useState<{ focus?: string } | null>(null);
  const [resumeQuery, setResumeQuery] = useState<string | null>(null);

  const runCommand = (text: string): boolean => {
    const opened = configCommandOf(text);
    if (opened) {
      setConfig(opened);
      return true;
    }
    const part = revealOf(text);
    if (part) {
      revealPart(controller.key, part);
      return true;
    }
    const command = parseAppCommand(
      text,
      state.model.init?.commands ?? state.model.slashCommands ?? [],
    );
    if (!command) return false;
    if (command.name === "resume") {
      if (state.model.running) {
        showToast({ kind: "warning", message: t("chat.commands.resume_busy") });
      } else setResumeQuery(command.args);
      return true;
    }
    const { history, model } = state;
    runAppCommand(command, {
      controller,
      workspaceId,
      tabId,
      cwd: props.cwd,
      rootPath,
      items: withRelayed(
        history ? [...history.items, ...model.items] : model.items,
        relayedOf(props),
      ),
      tools: history ? { ...history.tools, ...model.tools } : model.tools,
      summarize: (tool) => toolSummary(tool, props.cwd),
      openFileTab: links.openFileTab,
      openUrl: (url) => links.openUrl(url),
    }).catch((err: Error) => showToast({ kind: "error", message: err.message }));
    return true;
  };

  const forkSession = () => {
    const point = controller.forkPoint("", { before: false });
    if (point) {
      openClaudeTab(workspaceId, {
        cwd: props.cwd,
        fork: { sessionId: point.sessionId },
        ...controller.inherited(),
      });
    }
  };
  const stable = useStableHandlers({
    stopRun: (agentId: string) => void stopPrintRun(workspaceId, tabId, agentId),
    background: (toolUseId: string) => backgroundCall(controller, toolUseId),
    showAgent,
    showCall,
    forkSession,
    runCommand,
    switchProfile,
    continueInProfile,
  });
  const panel = (className: string) => (
    <SidePanel
      conversationTabId={isVisible ? tabId : undefined}
      controller={controller}
      state={steady}
      workspaceId={workspaceId}
      cwd={props.cwd}
      rootPath={rootPath}
      agents={agents}
      onStopRun={stable.stopRun}
      onShowAgent={stable.showAgent}
      onShowCall={stable.showCall}
      onBackground={stable.background}
      onForkSession={stable.forkSession}
      className={className}
    />
  );
  const { contextUsage, usage } = state.model;
  const usageLine = useMemo(
    () => (
      <ClaudeUsageLine
        workspaceId={workspaceId}
        profileId={props.profileId}
        visible={isVisible}
        contextUsage={contextUsage}
        usage={usage}
        trailing={(compact) => (
          <ProfileUsageChip
            agent="claude"
            workspaceId={workspaceId}
            profileId={props.profileId}
            use={tabUse}
            onSwitch={stable.switchProfile}
            onContinue={stable.continueInProfile}
            compact={compact}
          />
        )}
      />
    ),
    [workspaceId, props.profileId, isVisible, contextUsage, usage, tabUse, stable],
  );

  const view = (
    // biome-ignore lint/a11y/noStaticElementInteractions: ⌘[ and ⌘] step through the agents from anywhere in the tab
    <div
      ref={rootRef}
      className="chat-font relative flex h-full flex-col bg-background"
      style={fontStyle}
      data-testid="claude-tab"
      data-chat-drop
      onKeyDown={onKeyDown}
    >
      <ChatPhaseBanner
        scope={bannerScope}
        status={{
          agent: "claude",
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
      {props.openedBy && <ConversationParentChip opener={props.openedBy} />}
      <ConversationNoteChip />
      <ChatShell
        shell={shell}
        agents={agents}
        shown={shown}
        onShowAgent={showAgent}
        summaryCounts={() => summaryCountsOf(state.model, runRows)}
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
            history={pastModel}
            model={state.model}
            toolStatuses={toolStatuses}
            actions={shown ? undefined : actions}
            items={shownTranscript}
            itemsDone={shown !== undefined && shown.status !== "running"}
            reveal={shown ? null : callAsk}
            moves={props.moves}
            relayed={relayedOf(props)}
            historyTruncated={!shown && state.truncated}
            older={
              !shown && state.historyPage
                ? {
                    ...state.historyPage,
                    load: () =>
                      void controller
                        .loadEarlier()
                        .catch((error: Error) =>
                          showToast({ kind: "error", message: error.message }),
                        ),
                  }
                : undefined
            }
            empty={
              !shown && showsEmptyChat(state.phase) ? (
                <ChatEmptyState
                  agent="claude"
                  cwd={props.cwd}
                  error={resumeError}
                  onDismissError={() => setResumeError(null)}
                >
                  <SessionList
                    workspaceId={workspaceId}
                    tabId={tabId}
                    cwd={props.cwd}
                    profileId={controller.profileId}
                    onResume={(sessionId, profileId) => resumeSession(sessionId, profileId)}
                  />
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
                onClose={() => closeGoalBar(workspaceId, tabId, goal.goal)}
              />
            )
          }
          card={{ workspaceId, cwd: props.cwd, rootPath, onAnswer }}
          {...(shown ? { onToMain: () => showAgent(null) } : {})}
        />
        {showsLimitResume(props.limitResume) ? (
          <LimitResumeBanner workspaceId={workspaceId} tabId={tabId} record={props.limitResume} />
        ) : (
          <RateLimitBanner scope={bannerScope} limit={state.model.rateLimit} />
        )}
        <TurnFailureBanner
          scope={bannerScope}
          model={state.model}
          onRetry={(text) => controller.send(text)}
        />
        {isVisible && state.model.sessionId && (
          <TwinBanner
            key={state.model.sessionId}
            workspaceId={workspaceId}
            tabId={tabId}
            sessionId={state.model.sessionId}
          />
        )}
        <Composer
          instructions={instructions}
          controller={controller}
          state={steady}
          fallbackModels={fallbackModels}
          relayed={relayedOf(props)}
          local={isLocal}
          placeholder={shown ? t("chat.strip.input_to_main") : undefined}
          above={
            resumeQuery !== null ? (
              <SessionList
                workspaceId={workspaceId}
                tabId={tabId}
                cwd={props.cwd}
                profileId={controller.profileId}
                query={resumeQuery}
                exceptSessionId={controller.currentSession()}
                onClose={() => setResumeQuery(null)}
                onResume={(sessionId, profileId) => {
                  setResumeQuery(null);
                  resumeSession(sessionId, profileId, resumeFailed);
                }}
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
          onCommand={stable.runCommand}
          below={usageLine}
        />
      </ChatShell>
      <RewindDialog
        controller={controller}
        item={rewinding?.item ?? null}
        cwd={props.cwd}
        onClose={() => setRewinding(null)}
      />
      <ConfigDialog
        controller={controller}
        state={state}
        open={config !== null}
        focus={config?.focus}
        onClose={() => setConfig(null)}
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
        agent="claude"
        running={state.model.running}
      />
    </div>
  );
  return (
    <ChatNotesProvider
      workspaceId={workspaceId}
      tabId={tabId}
      agent="claude"
      session={props.sessionId}
      visible={isVisible}
    >
      <ChatLinksContext.Provider value={links}>{view}</ChatLinksContext.Provider>
    </ChatNotesProvider>
  );
}

const claudeChangesOf: ChangesOf = (path, tools) => {
  const before = changedFilesOf(tools).find((file) => file.path === path)?.before;
  return before !== undefined ? { [path]: before } : undefined;
};

function backgroundCall(controller: ChatController, toolUseId: string): void {
  controller
    .backgroundTool(toolUseId)
    .catch((err: Error) => showToast({ kind: "error", message: err.message }));
}

function forkFrom(
  controller: ChatController,
  workspaceId: string,
  cwd: string,
  item: UserItem | AssistantItem,
): void {
  if (!item.uuid) return;
  const user = item.kind === "user";
  const fork = controller.forkPoint(item.uuid, { before: user });
  if (!fork && !user) return;
  const tab = openClaudeTab(workspaceId, {
    cwd,
    ...(fork ? { fork } : {}),
    ...controller.inherited(),
  });
  if (user) {
    const draft: ComposerDraft = { text: item.text, images: item.images, nonce: Date.now() };
    useChatStore.getState().update(chatKey(workspaceId, tab.id), (prev) => ({ ...prev, draft }));
  }
}

const TwinBanner = memo(function TwinBanner({
  workspaceId,
  tabId,
  sessionId,
}: {
  workspaceId: string;
  tabId: string;
  sessionId: string;
}) {
  const { t } = useTranslation();
  const twin = useTerminalTwin(workspaceId, tabId, sessionId);
  const { dismiss, dismissed } = useBannerDismissal(
    ["chat-terminal-twin", workspaceId, tabId, sessionId],
    twin ? [twin] : undefined,
    twin !== undefined,
  );
  if (!twin || dismissed) return null;
  return (
    <div className="shrink-0" data-testid="chat-terminal-twin">
      <Banner
        variant="warning"
        message={t("chat.twin.message")}
        dismiss={dismiss}
        actions={[{ label: t("chat.twin.show"), onAction: () => revealTabById(workspaceId, twin) }]}
      />
    </div>
  );
});
