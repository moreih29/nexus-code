/**
 * The renderer's side of the nexus CLI: main asks, through cli:uiRequest,
 * for what only the renderer has — the tabs, the layout and the terminals'
 * screens — or to change it (./actions), and gets its answer through
 * cli.uiRespond.
 */

import { ipcCallResult, ipcListen } from "@/ipc/client";
import { useBrowserRuntimeStore } from "@/state/stores/browser-runtime";
import { allLeaves } from "@/state/stores/layout/helpers";
import { useLayoutStore } from "@/state/stores/layout/store";
import type { Tab } from "@/state/stores/tabs";
import { useTabsStore } from "@/state/stores/tabs";
import type { CliTabInfo, CliUiOp } from "../../../shared/cli/ui";
import { acknowledgedResults, unreadResults } from "../agent-sessions/inbox";
import { listed } from "../agent-sessions/rows";
import { readSessionEvents, recordSessionEvents } from "../agent-sessions/session-events";
import { inboxNow, markSessionRead } from "../agent-sessions/use-inbox";
import { orderedSidebarSessions } from "../agent-view/session-order";
import { existingChatController } from "../chat/claude/controller";
import { existingCodexController } from "../chat/codex/controller";
import { focusHolder, restoreFocus } from "../keep-focus";
import { startTerminalWatch, stopTerminalWatch } from "../remote/terminal-watch";
import { getTerminalController } from "../terminal/terminal-registry";
import {
  actionHandlers,
  type CliUiHandler,
  hasUnsavedChanges,
  startedTerminal,
  UiRequestError,
} from "./actions";
import { appHandlers } from "./app-actions";
import { chatHandlers } from "./chat-actions";
import { layoutHandlers } from "./layout-actions";
import { noteHandlers } from "./note-actions";
import { settingsHandlers } from "./settings";
import { viewHandlers } from "./view-actions";

function tabInfo(workspaceId: string, tab: Tab, groupId: string, shown: boolean): CliTabInfo {
  const base = {
    id: tab.id,
    type: tab.type,
    title: tab.title,
    groupId,
    shown,
    ...(hasUnsavedChanges(workspaceId, tab) ? { unsaved: true } : {}),
    ...(tab.isPinned ? { pinned: true } : {}),
  };
  switch (tab.type) {
    case "terminal":
      return {
        ...base,
        cwd: tab.props.cwd,
        ...(tab.props.dead ? { dead: true } : {}),
        ...(getTerminalController(tab.id) ? {} : { unstarted: true }),
        ...(tab.props.openedBy ? { openedBy: tab.props.openedBy } : {}),
      };
    case "claude":
    case "codex":
      return { ...base, ...(tab.props.openedBy ? { openedBy: tab.props.openedBy } : {}) };
    case "editor":
      return { ...base, filePath: tab.props.filePath };
    case "browser": {
      const runtime = useBrowserRuntimeStore.getState().runtimes.get(tab.id);
      return { ...base, url: runtime?.currentUrl || tab.props.lastUrl };
    }
    default:
      return base;
  }
}

/** A workspace's tabs, in layout order unless the remote sessions list asks for its own order. */
export function listTabs(
  workspaceId: string,
  agentOrder?: true,
  includeSession?: true,
): CliTabInfo[] {
  const layout = useLayoutStore.getState().byWorkspace[workspaceId];
  const records = useTabsStore.getState().byWorkspace[workspaceId] ?? {};
  if (!layout) return [];
  const tabs: CliTabInfo[] = [];
  for (const leaf of allLeaves(layout.root)) {
    for (const id of leaf.tabIds) {
      const tab = records[id];
      if (!tab) continue;
      const session = includeSession
        ? tab.type === "claude"
          ? tab.props.sessionId
          : tab.type === "codex"
            ? tab.props.threadId
            : undefined
        : undefined;
      tabs.push({
        ...tabInfo(workspaceId, tab, leaf.id, leaf.activeTabId === id),
        ...(session ? { session } : {}),
      });
    }
  }
  if (!agentOrder) return tabs;

  const remaining = new Map(tabs.map((tab) => [tab.id, tab]));
  const sidebar = (orderedSidebarSessions(workspaceId) ?? []).filter(listed);
  const ordered: CliTabInfo[] = [];
  for (const { tabId } of sidebar) {
    const tab = remaining.get(tabId);
    if (!tab) continue;
    ordered.push(tab);
    remaining.delete(tabId);
  }
  return [...ordered, ...remaining.values()];
}

const handlers: { [K in CliUiOp]: CliUiHandler<K> } = {
  "tabs.list": async ({ workspaceId, agentOrder, includeSession }) => ({
    tabs: listTabs(workspaceId, agentOrder, includeSession),
  }),
  "tab.sandboxSession": async ({ workspaceId, tabId }) => {
    const tab = useTabsStore.getState().byWorkspace[workspaceId]?.[tabId];
    if (tab?.type === "codex") {
      return existingCodexController(workspaceId, tabId)?.sandboxSession ?? null;
    }
    if (tab?.type === "claude") {
      return existingChatController(workspaceId, tabId)?.sandboxSession ?? null;
    }
    if (tab?.type === "terminal" && !tab.props.dead) {
      return getTerminalController(tabId)?.sandboxSession ?? null;
    }
    return null;
  },
  "terminal.read": async ({ workspaceId, tabId, lines, ansi }) => {
    const controller = await startedTerminal(workspaceId, tabId);
    return ansi ? controller.readScreen(lines) : { text: controller.readText(lines) };
  },
  "terminal.watch": async ({ workspaceId, tabId, watchId, lines, ansi }) => {
    const controller = await startedTerminal(workspaceId, tabId);
    return startTerminalWatch(
      watchId,
      controller,
      lines,
      (change) => void ipcCallResult("remote", "terminalChanged", { watchId, change }),
      () => void ipcCallResult("remote", "terminalWatchEnded", { watchId }),
      ansi ?? false,
    );
  },
  "terminal.unwatch": async ({ watchId }) => {
    stopTerminalWatch(watchId);
    return {};
  },
  "events.read": async ({ since, limit }) => readSessionEvents(since, limit),
  "sessions.results": async () => {
    const unread: Record<string, Record<string, number>> = Object.create(null);
    for (const { session, since } of unreadResults(inboxNow())) {
      unread[session.workspaceId] ??= Object.create(null);
      const tabs = unread[session.workspaceId];
      tabs[session.tabId] = since;
    }
    return { unread };
  },
  "sessions.markSeen": async ({ seen }) => {
    const results = acknowledgedResults(inboxNow(), seen);
    // A receipt can follow a listing before the session log's debounce has recorded completion.
    if (results.length === 0) return { marked: 0 };
    recordSessionEvents();
    for (const { session, since } of results) markSessionRead(session, since);
    recordSessionEvents();
    return { marked: results.length };
  },
  ...actionHandlers,
  ...appHandlers,
  ...chatHandlers,
  ...layoutHandlers,
  ...noteHandlers,
  ...settingsHandlers,
  ...viewHandlers,
};

/**
 * Requests that only read: nothing on screen moves, so the keyboard stays
 * where it is without the frames of checks restoreFocus schedules. The
 * remote sessions' list reads some of them every second.
 */
const READ_ONLY_OPS: ReadonlySet<string> = new Set<CliUiOp>([
  "tabs.list",
  "terminal.read",
  "terminal.shells",
  "tab.sandboxSession",
  "events.read",
  "sessions.results",
  "chat.state",
  "chat.read",
  "chat.page",
  "layout.get",
  "panels.get",
  "agentView.get",
  "problems.list",
]);

/** Removes the cli:uiRequest listener installed last, if it is still there. */
let stopListening: (() => void) | null = null;

// Hot reload may load this module anew; its listener goes with the old one.
import.meta.hot?.dispose(() => stopListening?.());

/**
 * Installs the cli:uiRequest listener, in place of one installed before.
 * Requests wait until startup restores layouts and the workspace list and selection.
 * Returns the unlisten function.
 *
 * A request leaves the keyboard where it was: one that splits the group of
 * the terminal it came from would otherwise leave that terminal without
 * focus (see ../keep-focus). One that only reads cannot drop it.
 */
export function startCliUiListener(ready: Promise<void>): () => void {
  // One listener, however often the app boots: a second would carry out
  // each request again, typing or sending twice. The dev build's hot reload
  // boots the app again with each edit.
  stopListening?.();
  const stop = ipcListen("cli", "uiRequest", ({ requestId, op, args }) => {
    void (async () => {
      try {
        await ready;
        const handler = handlers[op as CliUiOp] as CliUiHandler<CliUiOp> | undefined;
        const held = READ_ONLY_OPS.has(op) ? null : focusHolder();
        if (!handler) throw new UiRequestError(`unknown request ${op}`);
        const value = await handler(args as never).finally(() => restoreFocus(held));
        await ipcCallResult("cli", "uiRespond", { requestId, ok: true, value });
      } catch (error) {
        await ipcCallResult("cli", "uiRespond", {
          requestId,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    })();
  });
  const stopThis = (): void => {
    stop();
    if (stopListening === stopThis) stopListening = null;
  };
  stopListening = stopThis;
  return stopThis;
}
