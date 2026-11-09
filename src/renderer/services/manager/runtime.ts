/**
 * Runs the agent manager while it is on: main opens its workspace, and here
 * its Claude or Codex conversation starts, going on with the session it had,
 * whether or not its dock is open. The sessions' changes it is to hear of
 * are batched and sent it while it is not at work (./report), and what it
 * answers counts as unread while its dock is shut, and becomes a desktop
 * notification when the user is not looking (main decides).
 */

import i18next from "i18next";
import { isDefaultProfileId, profileOf } from "../../../shared/agent-profiles/profiles";
import type { CliSessionEvent } from "../../../shared/cli/ui";
import { createLogger } from "../../../shared/log/renderer";
import { MANAGER_PROMPT } from "../../../shared/manager/prompt";
import type { ChatAgent } from "../../../shared/sessions/task-agent";
import { ipcCallResult, ipcListen, unwrapIpcResult } from "../../ipc/client";
import { useAgentProfilesStore } from "../../state/stores/agent-profiles";
import { useManagerStore } from "../../state/stores/manager";
import { useWorkspacesStore } from "../../state/stores/workspaces";
import {
  type CodexController,
  type CodexTabHooks,
  codexController,
} from "../chat/codex-controller";
import { type ChatController, type ChatTabHooks, chatController } from "../chat/controller";
import { type ChatTabState, chatKey, useChatStore } from "../chat/store";
import { lastAnswer } from "../sessions/codex-state";
import { onSessionEvents } from "../sessions/session-events";
import { ReportQueue, reportable, reportOf } from "./report";

const log = createLogger("manager");

/** Changes that come together go in one report. */
const BATCH_MS = 2_000;
/** How much of an answer its notification shows. */
const NOTIFY_CHARS = 300;

interface Running {
  readonly agent: ChatAgent;
  readonly key: string;
  readonly controller: ChatController | CodexController;
}

/** The agent the manager is to run as; null while it is off. */
let wanted: ChatAgent | null = null;
let running: Running | null = null;
/** Counts the starts; one overtaken by a later start or a stop does nothing more. */
let starts = 0;
const queue = new ReportQueue();
let batchTimer: ReturnType<typeof setTimeout> | null = null;

function managerState(): ChatTabState | undefined {
  return running ? useChatStore.getState().tabs[running.key] : undefined;
}

/** Whether the manager can take a report now: started, and neither at work nor asking. */
function free(state: ChatTabState | undefined): boolean {
  if (!state) return false;
  if (state.phase !== "ready" && state.phase !== "ended") return false;
  return !state.model.running && state.model.permissions.length === 0;
}

async function start(agent: ChatAgent): Promise<void> {
  const mine = ++starts;
  let target: { workspaceId: string; tabId: string; cwd: string };
  try {
    target = unwrapIpcResult(await ipcCallResult("manager", "prepare", undefined));
  } catch (err) {
    log.warn(`the manager did not start: ${(err as Error).message}`);
    return;
  }
  if (mine !== starts) return;
  const { workspaceId, tabId, cwd } = target;
  const store = useManagerStore.getState();
  const session = store.session?.agent === agent ? store.session.id : undefined;
  // The manager runs with each agent's default profile, as Settings sets it.
  const { config } = useAgentProfilesStore.getState();
  const profile = profileOf(config, agent, config.defaults[agent]);
  const profileId = isDefaultProfileId(profile.id) ? {} : { profileId: profile.id };
  const controller =
    agent === "claude"
      ? chatController(
          { workspaceId, tabId, cwd, ...profileId, ...(session ? { sessionId: session } : {}) },
          managerClaudeHooks,
        )
      : codexController(
          {
            workspaceId,
            tabId,
            cwd,
            ...profileId,
            ...(session ? { threadId: session } : {}),
            developerInstructions: MANAGER_PROMPT,
            // Its rules let nexus out of Codex's sandbox (main writes them).
            trusted: true,
          },
          managerCodexHooks,
        );
  running = { agent, key: chatKey(workspaceId, tabId), controller };
  store.setLive({ agent, workspaceId, tabId, cwd, run: mine });
  await controller.open();
  flushSoon();
}

function stop(): void {
  starts++;
  const was = running;
  running = null;
  // What waited to be told was for that conversation.
  queue.take();
  useManagerStore.getState().setLive(undefined);
  if (was) void was.controller.close();
}

/** What the manager's Claude conversation keeps: the session it goes on with. */
export const managerClaudeHooks: ChatTabHooks = {
  onSession: (id) => useManagerStore.getState().setSession({ agent: "claude", id }),
  onTarget: ({ sessionId }) =>
    useManagerStore
      .getState()
      .setSession(sessionId ? { agent: "claude", id: sessionId } : undefined),
};

/** What the manager's Codex conversation keeps: the thread it goes on with. */
export const managerCodexHooks: CodexTabHooks = {
  onThread: (id) => useManagerStore.getState().setSession({ agent: "codex", id }),
};

/** Starts the manager over: a new conversation, the old one left to resume. */
export function newManagerConversation(): void {
  stop();
  useManagerStore.getState().setSession(undefined);
  if (wanted) void start(wanted);
}

/** Starts or stops the manager to match its settings. */
function apply(): void {
  const { enabled, agent } = useManagerStore.getState();
  const want = enabled ? agent : null;
  if (want === wanted) return;
  wanted = want;
  stop();
  if (want) {
    // Another agent's session is not this one's to go on with.
    if (useManagerStore.getState().session?.agent !== want) {
      useManagerStore.getState().setSession(undefined);
    }
    void start(want);
  }
}

function onEvents(events: readonly CliSessionEvent[]): void {
  const store = useManagerStore.getState();
  for (const event of events) {
    const key = `${event.workspaceId}:${event.tabId}`;
    const task = store.tasks[key] !== undefined;
    if (store.enabled && reportable(event, store.notify, task)) queue.add(event);
    if (task && event.to === "closed") store.dropTask(key);
  }
  if (queue.size > 0) flushSoon();
}

/**
 * Sends what is batched in a while. The while runs from the first change:
 * one a later change put off would never come while changes keep coming.
 */
function flushSoon(): void {
  if (batchTimer !== null) return;
  batchTimer = setTimeout(() => {
    batchTimer = null;
    flush();
  }, BATCH_MS);
}

/** Sends the batched changes, once the manager is free to take them. */
function flush(): void {
  if (queue.size === 0 || !running || !free(managerState())) return;
  const store = useManagerStore.getState();
  const tasks = new Set(Object.keys(store.tasks));
  const workspaces = useWorkspacesStore.getState().workspaces;
  const text = reportOf({
    events: queue.take(),
    tasks,
    workspaceName: (id) => workspaces.find((w) => w.id === id)?.name,
  });
  running.controller.send(text).catch((err: Error) => {
    log.warn(`a report was not sent: ${err.message}`);
  });
}

/** An answer of the manager's, ended now: unread while its dock is shut, and maybe a notification. */
function onTurnEnd(state: ChatTabState): void {
  const answer = lastAnswer(state.model);
  if (!answer) return;
  const store = useManagerStore.getState();
  if (!store.dockOpen) store.addUnread();
  const body = answer.length > NOTIFY_CHARS ? `${answer.slice(0, NOTIFY_CHARS - 1)}…` : answer;
  void ipcCallResult("manager", "notify", { title: i18next.t("manager.title"), body }).catch(
    () => {},
  );
}

/**
 * A request of the manager's, waiting on the user: unread while its dock is
 * shut, and maybe a notification. Its session's own notifications are left
 * out (features/claude), so this is the one.
 */
function onAsk(state: ChatTabState): void {
  const store = useManagerStore.getState();
  if (!store.dockOpen) store.addUnread();
  const tool = state.model.permissions[0]?.toolName ?? "";
  void ipcCallResult("manager", "notify", {
    title: i18next.t("manager.title"),
    body: i18next.t("manager.asks", { tool }),
  }).catch(() => {});
}

/** Starts the manager, if it is on, and follows its settings. Returns the stop. */
export function startManager(): () => void {
  apply();
  const stopSettings = useManagerStore.subscribe((now, was) => {
    if (now.enabled !== was.enabled || now.agent !== was.agent) apply();
  });
  const stopEvents = onSessionEvents(onEvents);
  // Its turns: one that ends may be told of; one that ends frees it for the reports waiting.
  const stopChat = useChatStore.subscribe((now, was) => {
    if (!running) return;
    const next = now.tabs[running.key];
    const prev = was.tabs[running.key];
    if (!next || next === prev) return;
    if (prev?.phase === "ready" && prev.model.running && !next.model.running) onTurnEnd(next);
    if (next.model.permissions.length > 0 && (prev?.model.permissions.length ?? 0) === 0) {
      onAsk(next);
    }
    if (queue.size > 0 && free(next) && !free(prev)) flushSoon();
  });
  const stopReveal = ipcListen("manager", "reveal", () => {
    useManagerStore.getState().setDockOpen(true);
  });
  return () => {
    stopSettings();
    stopEvents();
    stopChat();
    stopReveal();
    if (batchTimer !== null) clearTimeout(batchTimer);
  };
}
