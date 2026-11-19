import { expect, test } from "bun:test";
import { sessionKey } from "../../../../../src/renderer/services/agent-sessions/model";
import { startClaudeActiveContextSync } from "../../../../../src/renderer/state/claude-active-context-sync";
import { startNotificationClickListener } from "../../../../../src/renderer/state/notification-click";
import { useActiveStore } from "../../../../../src/renderer/state/stores/active";
import { useAgentViewStore } from "../../../../../src/renderer/state/stores/agent-view";
import { useAppFocusStore } from "../../../../../src/renderer/state/stores/app-focus";
import { useLayoutStore } from "../../../../../src/renderer/state/stores/layout";
import { useSessionSeenStore } from "../../../../../src/renderer/state/stores/session-seen";

for (const mode of ["workspace", "agents"] as const) {
  test(`a notification click marks the intended tab seen without visiting intermediate tabs in ${mode} mode`, () => {
    const from = crypto.randomUUID();
    const to = crypto.randomUUID();
    const fromTab = crypto.randomUUID();
    const intermediate = crypto.randomUUID();
    const target = crypto.randomUUID();
    const agentTab = crypto.randomUUID();
    const leaf = crypto.randomUUID();
    const contextCalls: unknown[] = [];
    const originalWindow = globalThis.window;
    const beforeMode = useAgentViewStore.getState();
    const beforeLayouts = useLayoutStore.getState().byWorkspace;
    const beforeSeen = useSessionSeenStore.getState().byWorkspace;
    const beforeActive = useActiveStore.getState().activeWorkspaceId;
    const beforeFocused = useAppFocusStore.getState().focused;
    let notify: ((payload: unknown) => void) | undefined;
    Object.assign(globalThis, {
      window: {
        ipc: {
          call: async (channel: string, method: string, body: unknown) => {
            if (channel === "claude" && method === "markSeen") contextCalls.push(body);
          },
          listen: (_channel: string, _event: string, cb: (payload: unknown) => void) => {
            notify = cb;
            return () => {};
          },
        },
      },
    });

    useActiveStore.setState({ activeWorkspaceId: from });
    useAppFocusStore.setState({ focused: true });
    useSessionSeenStore.setState({ byWorkspace: {} });
    useAgentViewStore.setState({
      mode,
      root: {
        kind: "leaf",
        id: leaf,
        tabIds: [sessionKey(from, agentTab)],
        activeTabId: sessionKey(from, agentTab),
      },
      activeLeafId: leaf,
    });
    useLayoutStore.setState({
      byWorkspace: {
        [from]: {
          root: { kind: "leaf", id: "from", tabIds: [fromTab], activeTabId: fromTab },
          activeGroupId: "from",
        },
        [to]: {
          root: {
            kind: "leaf",
            id: "to",
            tabIds: [intermediate, target],
            activeTabId: intermediate,
          },
          activeGroupId: "to",
        },
      },
    });
    const stopSync = startClaudeActiveContextSync();
    const stopNotifications = startNotificationClickListener();
    contextCalls.length = 0;
    try {
      notify?.({ workspaceId: to, tabId: target });
      expect(contextCalls).toEqual([{ workspaceId: to, tabId: target }]);
      const seen = useSessionSeenStore.getState().byWorkspace;
      expect(seen[to]?.[intermediate]).toBeUndefined();
      expect(seen[to]?.[target]).toBeNumber();
      if (mode === "agents") expect(seen[from]?.[fromTab]).toBeUndefined();
    } finally {
      stopSync();
      stopNotifications();
      useLayoutStore.setState({ byWorkspace: beforeLayouts });
      useActiveStore.setState({ activeWorkspaceId: beforeActive });
      useAppFocusStore.setState({ focused: beforeFocused });
      useAgentViewStore.setState(beforeMode);
      useSessionSeenStore.setState({ byWorkspace: beforeSeen });
      Object.assign(globalThis, { window: originalWindow });
    }
  });
}
