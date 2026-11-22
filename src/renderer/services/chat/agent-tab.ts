/**
 * Claude and Codex tabs the app drives on its own, for a new task or the
 * nexus CLI: what each keeps of its conversation, as the tab's view keeps
 * it, and messages that start the conversation whether or not the tab is
 * ever shown.
 */

import {
  type AgentProfiles,
  isDefaultProfileId,
  profileOf,
} from "../../../shared/agent-profiles/profiles";
import {
  mergeAgentInstructions,
  workspaceInstructionTarget,
} from "../../../shared/chat/instructions";
import type { RelaySender, TerminalOpener } from "../../../shared/chat/relay";
import { createLogger } from "../../../shared/log/renderer";
import type { ChatAgent } from "../../../shared/sessions/task-agent";
import { openClaudeTab, openCodexTab } from "../../state/operations/tabs";
import {
  currentSessionInstructions,
  rememberSessionInstructions,
  useAgentInstructionsStore,
} from "../../state/stores/agent-instructions";
import { useAgentProfilesStore } from "../../state/stores/agent-profiles";
import { useTabsStore } from "../../state/stores/tabs";
import { useWorkspacesStore } from "../../state/stores/workspaces";
import { notesApi } from "../notes/api";
import { tabLinkTarget } from "../notes/conversation";
import { liveAnswerOf } from "../notes/live-answer";
import { type ChatController, type ChatTabHooks, chatController } from "./claude/controller";
import { type CodexController, type CodexTabHooks, codexController } from "./codex/controller";
import type { ChatModel } from "./model";
import { clipTitle, titleOf } from "./tab-title";
import { sendFirstMessage } from "./transport/submission";

const log = createLogger("note-links");

function syncNoteLinks(workspaceId: string, tabId: string): void {
  const tab = useTabsStore.getState().byWorkspace[workspaceId]?.[tabId];
  if (tab?.type !== "claude" && tab?.type !== "codex") return;
  void notesApi
    .updateLinksForTab({ ...tabLinkTarget(workspaceId, tab), agent: tab.type })
    .catch((error) => log.warn(`Linked conversation not updated: ${String(error)}`));
}

function saveLiveAnswer(workspaceId: string, tabId: string, model: ChatModel): void {
  const tab = useTabsStore.getState().byWorkspace[workspaceId]?.[tabId];
  if (tab?.type !== "claude" && tab?.type !== "codex") return;
  const snapshot = liveAnswerOf(model);
  if (!snapshot) return;
  const { session, profileId } = tabLinkTarget(workspaceId, tab);
  void notesApi
    .updateLiveAnswer({ workspaceId, tabId, profileId, session, agent: tab.type }, snapshot)
    .catch((error) => log.warn(`Live note card not updated: ${String(error)}`));
}

/** What a Claude tab keeps: the session to go on with, and its title. */
export function claudeTabHooks(workspaceId: string, tabId: string): ChatTabHooks {
  const tabs = () => useTabsStore.getState();
  return {
    instructions: (sessionId) => currentSessionInstructions(workspaceId, tabId, sessionId),
    mergedInstructions: (profileId, session) =>
      mergeAgentInstructions(
        useAgentInstructionsStore.getState().config,
        agentInstructionTarget(workspaceId, "claude", profileId, session),
      ),
    onSession: (sessionId) => {
      rememberSessionInstructions(workspaceId, tabId, sessionId);
      tabs().setClaudeSession(workspaceId, tabId, sessionId);
      syncNoteLinks(workspaceId, tabId);
    },
    onTarget: (target) => {
      if (target.sessionId) rememberSessionInstructions(workspaceId, tabId, target.sessionId);
      tabs().setClaudeTarget(workspaceId, tabId, target);
      if (target.sessionId) syncNoteLinks(workspaceId, tabId);
    },
    onFirstMessage: (text) => tabs().setProcessTitle(workspaceId, tabId, titleOf(text)),
    onTitle: (title) => {
      tabs().setProcessTitle(workspaceId, tabId, clipTitle(title));
      syncNoteLinks(workspaceId, tabId);
    },
    // The user's own name for it, whole, as the tab's rename menu keeps one.
    onRename: (title) => tabs().renameTab(workspaceId, tabId, title),
    onProfile: (profileId) =>
      tabs().setChatProfile(
        workspaceId,
        tabId,
        isDefaultProfileId(profileId) ? undefined : profileId,
      ),
    onMoves: (moves) => tabs().setChatMoves(workspaceId, tabId, moves),
    onRelayed: (record) => tabs().addChatRelayed(workspaceId, tabId, record),
    onPeerWritten: (id) => {
      const tab = tabs().byWorkspace[workspaceId]?.[tabId];
      const submission = tab?.type === "claude" ? tab.props.peerSubmissions?.[id] : undefined;
      if (submission)
        tabs().addChatPeerSubmission(workspaceId, tabId, id, { ...submission, written: true });
    },
    onChosen: (chosen) => tabs().setChatChosen(workspaceId, tabId, chosen),
    onTurnEnd: (model) => saveLiveAnswer(workspaceId, tabId, model),
  };
}

/** What a Codex tab keeps: the thread to go on with, and its title. */
export function codexTabHooks(workspaceId: string, tabId: string): CodexTabHooks {
  const tabs = () => useTabsStore.getState();
  return {
    instructions: (threadId) => currentSessionInstructions(workspaceId, tabId, threadId),
    onThread: (threadId) => {
      rememberSessionInstructions(workspaceId, tabId, threadId);
      tabs().setCodexThread(workspaceId, tabId, threadId);
      syncNoteLinks(workspaceId, tabId);
    },
    onFirstMessage: (text) => tabs().setProcessTitle(workspaceId, tabId, titleOf(text)),
    onTitle: (title) => {
      tabs().setProcessTitle(workspaceId, tabId, clipTitle(title));
      syncNoteLinks(workspaceId, tabId);
    },
    onProfile: (profileId) =>
      tabs().setChatProfile(
        workspaceId,
        tabId,
        isDefaultProfileId(profileId) ? undefined : profileId,
      ),
    onMoves: (moves) => tabs().setChatMoves(workspaceId, tabId, moves),
    onRelayed: (record) => tabs().addChatRelayed(workspaceId, tabId, record),
    onChosen: (chosen) => tabs().setChatChosen(workspaceId, tabId, chosen),
    onTurnEnd: (model) => saveLiveAnswer(workspaceId, tabId, model),
  };
}

/** A running program can still use a profile that has been removed from Settings. */
export function instructionProfileOf(
  config: AgentProfiles,
  agent: ChatAgent,
  id: string | undefined,
) {
  const profile = profileOf(config, agent, id);
  return id && id !== profile.id ? { ...profile, id, name: id } : profile;
}

export function agentInstructionTarget(
  workspaceId: string,
  agent: ChatAgent,
  profileId?: string,
  session?: string,
) {
  const { workspaces } = useWorkspacesStore.getState();
  const workspace = workspaceInstructionTarget(
    workspaces.find(({ id }) => id === workspaceId),
    workspaces,
  );
  const profile = instructionProfileOf(useAgentProfilesStore.getState().config, agent, profileId);
  return { agent, profile, workspace, session };
}

/** A Claude or Codex tab's controller, and which agent it runs. */
export type AgentTabController =
  | { readonly agent: "claude"; readonly controller: ChatController }
  | { readonly agent: "codex"; readonly controller: CodexController };

/**
 * The controller of a Claude or Codex tab, made as its view makes it when
 * the view has not; null when the tab is neither, or gone.
 */
export function agentTabController(workspaceId: string, tabId: string): AgentTabController | null {
  const tab = useTabsStore.getState().byWorkspace[workspaceId]?.[tabId];
  if (tab?.type === "claude") {
    const { cwd, sessionId, fork, profileId, moves, chosen } = tab.props;
    return {
      agent: "claude",
      controller: chatController(
        {
          workspaceId,
          tabId,
          cwd,
          sessionId,
          fork,
          ...(profileId ? { profileId } : {}),
          ...(moves ? { moves } : {}),
          ...(chosen ? { chosen } : {}),
        },
        claudeTabHooks(workspaceId, tabId),
      ),
    };
  }
  if (tab?.type === "codex") {
    const { cwd, threadId, fork, profileId, moves, chosen } = tab.props;
    return {
      agent: "codex",
      controller: codexController(
        {
          workspaceId,
          tabId,
          cwd,
          threadId,
          fork,
          ...(profileId ? { profileId } : {}),
          ...(moves ? { moves } : {}),
          ...(chosen ? { chosen } : {}),
        },
        codexTabHooks(workspaceId, tabId),
      ),
    };
  }
  return null;
}

/**
 * Starts the program of a new Claude or Codex tab and sends it `message`
 * when there is one, from the agent that asked for the tab (`from`) when
 * one did; shown or not, the conversation starts now.
 */
export function startAgentTab(
  workspaceId: string,
  tabId: string,
  message: string,
  from?: RelaySender,
): void {
  const text = message.trim();
  const target = agentTabController(workspaceId, tabId);
  if (text === "" || !target) return;
  void sendFirstMessage(workspaceId, tabId, target, text, from).catch(() => {});
}

/**
 * Opens a new `agent` tab in `cwd`, in the workspace's active group, and
 * sends it `message` when there is one (see startAgentTab). Returns the
 * tab's id.
 */
export function openAgentTab(
  workspaceId: string,
  agent: ChatAgent,
  cwd: string,
  message: string,
  profileId?: string,
  from?: RelaySender,
  openedBy?: TerminalOpener,
): string {
  const props = { cwd, ...(profileId ? { profileId } : {}), ...(openedBy ? { openedBy } : {}) };
  const { id: tabId } =
    agent === "claude" ? openClaudeTab(workspaceId, props) : openCodexTab(workspaceId, props);
  startAgentTab(workspaceId, tabId, message, from);
  return tabId;
}
