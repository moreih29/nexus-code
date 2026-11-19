import { expect, test } from "bun:test";
import { type ToastInput, watchToasts } from "../../../../../src/renderer/components/ui/toast";
import { initGitErrorToasts } from "../../../../../src/renderer/services/error-surface/git-error-toasts";
import { useActiveStore } from "../../../../../src/renderer/state/stores/active";
import { useAgentViewStore } from "../../../../../src/renderer/state/stores/agent-view";
import { useGitStore } from "../../../../../src/renderer/state/stores/git";
import { createDefaultSession } from "../../../../../src/renderer/state/stores/git/session-defaults";
import { useUIStore } from "../../../../../src/renderer/state/stores/ui";

test("a recoverable Git error remains visible while the agent view hides Source Control", () => {
  const workspaceId = crypto.randomUUID();
  const oldMode = useAgentViewStore.getState().mode;
  const oldUI = useUIStore.getState();
  const oldActive = useActiveStore.getState().activeWorkspaceId;
  const oldSessions = useGitStore.getState().sessions;
  const toasts: ToastInput[] = [];
  const stop = watchToasts((toast) => toasts.push(toast));
  useActiveStore.setState({ activeWorkspaceId: workspaceId });
  useAgentViewStore.setState({ mode: "agents" });
  useUIStore.setState({
    filesPanelHidden: false,
    filesPanelModes: new Map([[workspaceId, "git"]]),
  });
  try {
    initGitErrorToasts();
    useGitStore.setState({
      sessions: new Map([
        [
          workspaceId,
          createDefaultSession({
            lastError: {
              kind: "non-fast-forward",
              message: "Pull before pushing",
              operation: "push",
            },
          }),
        ],
      ]),
    });
    expect(toasts).toHaveLength(1);
    toasts[0].actions?.[0]?.onAction();
    expect(useAgentViewStore.getState().mode).toBe("workspace");
  } finally {
    stop();
    useGitStore.setState({ sessions: oldSessions });
    useUIStore.setState(oldUI);
    useActiveStore.setState({ activeWorkspaceId: oldActive });
    useAgentViewStore.setState({ mode: oldMode });
  }
});
