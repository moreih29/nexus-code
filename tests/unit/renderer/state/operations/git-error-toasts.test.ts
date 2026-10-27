/**
 * initGitErrorToasts — which git failures reach a toast.
 *
 * Drives the real git, active and UI stores; only showToast is replaced with
 * a spy (spread over the real module so later files keep its other exports).
 */
import { beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import type { ToastInput } from "../../../../../src/renderer/components/ui/toast";

const toasts: ToastInput[] = [];
const realToast = await import("../../../../../src/renderer/components/ui/toast");
mock.module("../../../../../src/renderer/components/ui/toast", () => ({
  ...realToast,
  showToast: (input: ToastInput) => {
    toasts.push(input);
  },
}));

const { initGitErrorToasts } = await import(
  "../../../../../src/renderer/state/operations/git-error-toasts"
);
const { useGitStore } = await import("../../../../../src/renderer/state/stores/git");
const { createDefaultSession } = await import(
  "../../../../../src/renderer/state/stores/git/session-defaults"
);
const { useActiveStore } = await import("../../../../../src/renderer/state/stores/active");
const { useUIStore } = await import("../../../../../src/renderer/state/stores/ui");
type GitStoreError = import("../../../../../src/renderer/state/stores/git/types").GitStoreError;

const WS = "ws-git-error-toasts";

function fail(error: GitStoreError): void {
  const sessions = new Map(useGitStore.getState().sessions);
  const session = sessions.get(WS) ?? createDefaultSession();
  sessions.set(WS, { ...session, lastError: error });
  useGitStore.setState({ sessions });
}

function showSourceControl(visible: boolean): void {
  useActiveStore.setState({ activeWorkspaceId: WS });
  useUIStore.setState({
    filesPanelHidden: false,
    filesPanelModes: new Map([[WS, visible ? "git" : "tree"]]),
  });
}

beforeAll(() => {
  useGitStore.setState({ sessions: new Map([[WS, createDefaultSession()]]) });
  initGitErrorToasts();
});

beforeEach(() => {
  toasts.length = 0;
  showSourceControl(true);
});

describe("initGitErrorToasts", () => {
  it("toasts a failed action with its summary and git's output as details", () => {
    const message = "hint: try again\nfatal: unable to access 'https://x/': timed out";
    fail({ kind: "unknown", message, operation: "fetch" });

    expect(toasts).toEqual([
      { kind: "error", message: "Unable to access 'https://x/': timed out", details: message },
    ]);
  });

  it("leaves a failure the panel recovers from to the panel while it is on screen", () => {
    fail({ kind: "non-fast-forward", message: "Push rejected.", operation: "push" });

    expect(toasts).toEqual([]);
  });

  it("points to Source Control when such a failure happens off screen", () => {
    showSourceControl(false);
    useUIStore.setState({ filesPanelHidden: true });
    fail({ kind: "non-fast-forward", message: "Push rejected.", operation: "push" });

    expect(toasts).toHaveLength(1);
    expect(toasts[0]).toMatchObject({ kind: "error", message: "Push rejected." });
    const [action] = toasts[0]?.actions ?? [];
    expect(action?.label).toBe("Open Source Control");

    useActiveStore.setState({ activeWorkspaceId: "another-workspace" });
    // Showing the files panel persists the flag through IPC.
    const global = globalThis as { window?: unknown };
    const previousWindow = global.window;
    global.window = { ipc: { call: async () => ({ ok: true, value: undefined }) } };
    try {
      action?.onAction();
    } finally {
      global.window = previousWindow;
    }
    expect(useActiveStore.getState().activeWorkspaceId).toBe(WS);
    expect(useUIStore.getState().filesPanelHidden).toBe(false);
    expect(useUIStore.getState().filesPanelModes.get(WS)).toBe("git");
  });

  it("never toasts a status refresh failure", () => {
    showSourceControl(false);
    fail({ kind: "unknown", message: "Not a git repository.", operation: "refresh" });

    expect(toasts).toEqual([]);
  });

  it("toasts each failure once, however often the store changes after it", () => {
    fail({ kind: "unknown", message: "Commit failed.", operation: "commit" });
    useGitStore.setState({ sessions: new Map(useGitStore.getState().sessions) });

    expect(toasts).toHaveLength(1);
  });
});
