/**
 * Renderer controller for SSH authentication prompts.
 *
 * It owns the singleton `sshAuth.prompt` listener, serializes prompts in FIFO
 * order, and sends typed responses/cancellations back to main.
 */
import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import type { SshAuthPrompt } from "../../../shared/ssh/auth-prompt";
import { ipcCall, ipcListen } from "../../ipc/client";

export interface SshAuthPromptSnapshot {
  readonly pendingPrompts: readonly SshAuthPrompt[];
  readonly currentPrompt: SshAuthPrompt | null;
}

export interface SshAuthPromptDeps {
  readonly call?: typeof ipcCall;
  readonly listen?: typeof ipcListen;
}

export interface SshAuthPromptState {
  readonly currentPrompt: SshAuthPrompt | null;
  readonly pendingPrompts: readonly SshAuthPrompt[];
  readonly pendingMessage: string | null;
  readonly respondPassword: (value: string) => void;
  readonly trustHostKey: () => void;
  readonly cancelCurrent: () => void;
}

const EMPTY_SNAPSHOT: SshAuthPromptSnapshot = {
  pendingPrompts: [],
  currentPrompt: null,
};
const DEFAULT_DEPS: Required<SshAuthPromptDeps> = {
  call: ipcCall,
  listen: ipcListen,
};

let promptQueue: readonly SshAuthPrompt[] = [];
let promptSnapshot: SshAuthPromptSnapshot = EMPTY_SNAPSHOT;
const subscribers = new Set<() => void>();

/** Returns the current global SSH auth prompt snapshot. */
export function getSshAuthPromptSnapshot(): SshAuthPromptSnapshot {
  return promptSnapshot;
}

/** Subscribes to the process-wide SSH auth prompt store. */
export function subscribeSshAuthPromptSnapshot(listener: () => void): () => void {
  subscribers.add(listener);
  return () => {
    subscribers.delete(listener);
  };
}

/** Installs the singleton prompt listener used by GlobalRoots. */
export function installSshAuthPromptListeners(listen: typeof ipcListen = ipcListen): () => void {
  return listen("sshAuth", "prompt", (prompt) => {
    enqueuePrompt(prompt);
  });
}

/** Computes the visible FIFO counter copy for the active dialog. */
export function sshAuthPendingMessage(pendingPrompts: readonly SshAuthPrompt[]): string | null {
  if (pendingPrompts.length <= 1) return null;
  return `1 / ${pendingPrompts.length} pending`;
}

/**
 * Mount once from GlobalRoots. The hook owns the only renderer response path
 * for SSH auth prompts initiated by remote workspace connections.
 */
export function useSshAuthPrompts(deps: SshAuthPromptDeps = DEFAULT_DEPS): SshAuthPromptState {
  const { currentPrompt, pendingPrompts } = useSshAuthPromptSnapshot();
  const call = deps.call ?? DEFAULT_DEPS.call;
  const listen = deps.listen ?? DEFAULT_DEPS.listen;

  useEffect(() => installSshAuthPromptListeners(listen), [listen]);

  const respondPassword = useCallback(
    (value: string) => {
      const prompt = currentPrompt;
      if (!prompt || prompt.kind !== "password") return;
      clearPrompt(prompt.promptId);
      call("sshAuth", "respond", { kind: "password", promptId: prompt.promptId, value }).catch(
        (error) => {
          console.error("[ssh-auth] password response failed", error);
        },
      );
    },
    [call, currentPrompt],
  );

  const trustHostKey = useCallback(() => {
    const prompt = currentPrompt;
    if (!prompt || prompt.kind !== "host-key") return;
    clearPrompt(prompt.promptId);
    call("sshAuth", "respond", { kind: "host-key", promptId: prompt.promptId, trust: "yes" }).catch(
      (error) => {
        console.error("[ssh-auth] host-key response failed", error);
      },
    );
  }, [call, currentPrompt]);

  const cancelCurrent = useCallback(() => {
    const prompt = currentPrompt;
    if (!prompt) return;
    clearPrompt(prompt.promptId);
    call("sshAuth", "cancel", { promptId: prompt.promptId }).catch((error) => {
      console.error("[ssh-auth] prompt cancel failed", error);
    });
  }, [call, currentPrompt]);

  const pendingMessage = useMemo(() => sshAuthPendingMessage(pendingPrompts), [pendingPrompts]);

  return {
    currentPrompt,
    pendingPrompts,
    pendingMessage,
    respondPassword,
    trustHostKey,
    cancelCurrent,
  };
}

/** Test-only reset helper for the module-level prompt store. */
export function __resetSshAuthPromptsForTests(): void {
  promptQueue = [];
  promptSnapshot = EMPTY_SNAPSHOT;
  notifySubscribers();
}

/** Reads the global SSH auth prompt snapshot from React safely. */
function useSshAuthPromptSnapshot(): SshAuthPromptSnapshot {
  return useSyncExternalStore(
    subscribeSshAuthPromptSnapshot,
    getSshAuthPromptSnapshot,
    getSshAuthPromptSnapshot,
  );
}

/** Adds prompts FIFO, replacing duplicate prompt ids in place for retry text. */
function enqueuePrompt(prompt: SshAuthPrompt): void {
  updateQueue((current) => {
    const duplicateIndex = current.findIndex((item) => item.promptId === prompt.promptId);
    if (duplicateIndex === -1) return [...current, prompt];
    return current.map((item, index) => (index === duplicateIndex ? prompt : item));
  });
}

/** Removes a completed/cancelled prompt and advances the FIFO. */
function clearPrompt(promptId: string): void {
  updateQueue((current) => current.filter((prompt) => prompt.promptId !== promptId));
}

/** Applies a queue mutation and emits a stable snapshot to subscribers. */
function updateQueue(updater: (current: readonly SshAuthPrompt[]) => readonly SshAuthPrompt[]): void {
  promptQueue = updater(promptQueue);
  promptSnapshot = {
    pendingPrompts: promptQueue,
    currentPrompt: promptQueue[0] ?? null,
  };
  notifySubscribers();
}

/** Notifies React external-store subscribers. */
function notifySubscribers(): void {
  for (const subscriber of subscribers) subscriber();
}
