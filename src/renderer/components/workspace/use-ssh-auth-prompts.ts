import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { createLogger } from "../../../shared/log/renderer";
import type { SshAuthPrompt } from "../../../shared/ssh/auth-prompt";
import { ipcCallResult, ipcListen } from "../../ipc/client";
import { useActiveStore } from "../../state/stores/active";
import { usePeerWorkspaceStore } from "../../state/stores/peer-workspace";

const log = createLogger("ssh-auth");

export interface SshAuthPromptSnapshot {
  readonly pendingPrompts: readonly SshAuthPrompt[];
  readonly currentPrompt: SshAuthPrompt | null;
}

export interface SshAuthPromptDeps {
  readonly call?: typeof ipcCallResult;
  readonly listen?: typeof ipcListen;
}

export interface SshAuthPromptState {
  readonly currentPrompt: SshAuthPrompt | null;
  readonly pendingPrompts: readonly SshAuthPrompt[];
  readonly pendingMessage: string | null;
  readonly isReattach: boolean;
  readonly respondPassword: (value: string) => void;
  readonly trustHostKey: () => void;
  readonly cancelCurrent: () => void;
}

const EMPTY_SNAPSHOT: SshAuthPromptSnapshot = {
  pendingPrompts: [],
  currentPrompt: null,
};
const DEFAULT_DEPS: Required<SshAuthPromptDeps> = {
  call: ipcCallResult,
  listen: ipcListen,
};

let promptQueue: readonly SshAuthPrompt[] = [];
let promptSnapshot: SshAuthPromptSnapshot = EMPTY_SNAPSHOT;
const subscribers = new Set<() => void>();

const heldWorkspaceIds = new Set<string>();

export function getSshAuthPromptSnapshot(): SshAuthPromptSnapshot {
  return promptSnapshot;
}

export function subscribeSshAuthPromptSnapshot(listener: () => void): () => void {
  subscribers.add(listener);
  return () => {
    subscribers.delete(listener);
  };
}

export function installSshAuthPromptListeners(listen: typeof ipcListen = ipcListen): () => void {
  const unlistenPrompt = listen("sshAuth", "prompt", (prompt) => {
    enqueuePrompt(prompt);
  });

  const unlistenDismissed = listen("sshAuth", "dismissed", ({ promptId }) => clearPrompt(promptId));

  const unlistenHeld = listen("pty", "held", (args) => {
    heldWorkspaceIds.add(args.workspaceId);
  });

  const unlistenRestored = listen("pty", "restored", (args) => {
    heldWorkspaceIds.delete(args.workspaceId);
  });

  const unlistenExpired = listen("pty", "expired", (args) => {
    heldWorkspaceIds.delete(args.workspaceId);
  });

  return () => {
    unlistenPrompt();
    unlistenDismissed();
    unlistenHeld();
    unlistenRestored();
    unlistenExpired();
  };
}

export function sshAuthPendingMessage(pendingPrompts: readonly SshAuthPrompt[]): string | null {
  if (pendingPrompts.length <= 1) return null;
  return `1 / ${pendingPrompts.length} pending`;
}

export function useSshAuthPrompts(deps: SshAuthPromptDeps = DEFAULT_DEPS): SshAuthPromptState {
  const { currentPrompt: rawCurrentPrompt, pendingPrompts } = useSshAuthPromptSnapshot();
  const call = deps.call ?? DEFAULT_DEPS.call;
  const listen = deps.listen ?? DEFAULT_DEPS.listen;

  const activeWorkspaceId = useActiveStore((s) => s.activeWorkspaceId);
  const viewingPeer = usePeerWorkspaceStore((s) => s.active !== null);

  const currentPrompt = useMemo<SshAuthPrompt | null>(() => {
    if (rawCurrentPrompt === null || viewingPeer) return null;
    if (!rawCurrentPrompt.workspaceId) return rawCurrentPrompt;
    if (activeWorkspaceId === null) return rawCurrentPrompt;
    if (rawCurrentPrompt.workspaceId === activeWorkspaceId) return rawCurrentPrompt;
    const activePrompt = pendingPrompts.find(
      (p) => !p.workspaceId || p.workspaceId === activeWorkspaceId,
    );
    return activePrompt ?? null;
  }, [rawCurrentPrompt, activeWorkspaceId, pendingPrompts, viewingPeer]);

  useEffect(() => {
    const dispose = installSshAuthPromptListeners(listen);
    void call("sshAuth", "pending", undefined)
      .then((result) => {
        if (!result.ok) {
          log.error(`pending prompt sync failed: ${result.message}`);
          return;
        }
        for (const prompt of result.value) enqueuePrompt(prompt);
      })
      .catch((error: unknown) => {
        log.error(`pending prompt sync failed: ${(error as Error).message}`);
      });
    return dispose;
  }, [call, listen]);

  const respondPassword = useCallback(
    (value: string) => {
      const prompt = currentPrompt;
      if (!prompt || prompt.kind !== "password") return;
      clearPrompt(prompt.promptId);
      void call("sshAuth", "respond", { kind: "password", promptId: prompt.promptId, value }).then(
        (result) => {
          if (!result.ok) log.error(`password response failed: ${result.message}`);
        },
      );
    },
    [call, currentPrompt],
  );

  const trustHostKey = useCallback(() => {
    const prompt = currentPrompt;
    if (!prompt || prompt.kind !== "host-key") return;
    clearPrompt(prompt.promptId);
    void call("sshAuth", "respond", {
      kind: "host-key",
      promptId: prompt.promptId,
      trust: "yes",
    }).then((result) => {
      if (!result.ok) log.error(`host-key response failed: ${result.message}`);
    });
  }, [call, currentPrompt]);

  const cancelCurrent = useCallback(() => {
    const prompt = currentPrompt;
    if (!prompt) return;
    clearPrompt(prompt.promptId);
    void call("sshAuth", "cancel", { promptId: prompt.promptId }).then((result) => {
      if (!result.ok) log.error(`prompt cancel failed: ${result.message}`);
    });
  }, [call, currentPrompt]);

  const isReattach = useMemo<boolean>(() => {
    if (!currentPrompt?.workspaceId) return false;
    return heldWorkspaceIds.has(currentPrompt.workspaceId);
  }, [currentPrompt]);

  const pendingMessage = useMemo(() => sshAuthPendingMessage(pendingPrompts), [pendingPrompts]);

  return {
    currentPrompt,
    pendingPrompts,
    pendingMessage,
    isReattach,
    respondPassword,
    trustHostKey,
    cancelCurrent,
  };
}

export function __resetSshAuthPromptsForTests(): void {
  promptQueue = [];
  promptSnapshot = EMPTY_SNAPSHOT;
  heldWorkspaceIds.clear();
  notifySubscribers();
}

export function __markWorkspaceHeldForTests(workspaceId: string): void {
  heldWorkspaceIds.add(workspaceId);
}

export function __clearHeldWorkspacesForTests(): void {
  heldWorkspaceIds.clear();
}

function useSshAuthPromptSnapshot(): SshAuthPromptSnapshot {
  return useSyncExternalStore(
    subscribeSshAuthPromptSnapshot,
    getSshAuthPromptSnapshot,
    getSshAuthPromptSnapshot,
  );
}

function enqueuePrompt(prompt: SshAuthPrompt): void {
  updateQueue((current) => {
    const duplicateIndex = current.findIndex((item) => item.promptId === prompt.promptId);
    if (duplicateIndex === -1) return [...current, prompt];
    return current.map((item, index) => (index === duplicateIndex ? prompt : item));
  });
}

function clearPrompt(promptId: string): void {
  updateQueue((current) => current.filter((prompt) => prompt.promptId !== promptId));
}

function updateQueue(
  updater: (current: readonly SshAuthPrompt[]) => readonly SshAuthPrompt[],
): void {
  promptQueue = updater(promptQueue);
  promptSnapshot = {
    pendingPrompts: promptQueue,
    currentPrompt: promptQueue[0] ?? null,
  };
  notifySubscribers();
}

function notifySubscribers(): void {
  for (const subscriber of subscribers) subscriber();
}
