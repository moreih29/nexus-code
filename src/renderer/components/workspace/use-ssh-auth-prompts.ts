/**
 * Renderer controller for SSH authentication prompts.
 *
 * It owns the singleton `sshAuth.prompt` listener, serializes prompts in FIFO
 * order, and sends typed responses/cancellations back to main.
 *
 * Workspace-active queuing: prompts for a specific workspace are deferred until
 * that workspace is active. Prompts without a workspaceId are shown immediately
 * (legacy/unknown source). This prevents focus-stealing from inactive workspaces
 * during the auto-reauth flow (plan issue 6).
 */
import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { createLogger } from "../../../shared/log/renderer";
import type { SshAuthPrompt } from "../../../shared/ssh/auth-prompt";
import { ipcCallResult, ipcListen } from "../../ipc/client";
import { useActiveStore } from "../../state/stores/active";

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
  /** True when the currentPrompt is for a reattach scenario. */
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

/**
 * Workspaces that currently have PTY sessions on hold (pty.held received).
 * Used to detect when a password prompt is a reattach-context prompt.
 */
const heldWorkspaceIds = new Set<string>();

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
  const unlistenPrompt = listen("sshAuth", "prompt", (prompt) => {
    enqueuePrompt(prompt);
  });

  // Track held/restored/expired so we know which prompts are reattach-context.
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
    unlistenHeld();
    unlistenRestored();
    unlistenExpired();
  };
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
  const { currentPrompt: rawCurrentPrompt, pendingPrompts } = useSshAuthPromptSnapshot();
  const call = deps.call ?? DEFAULT_DEPS.call;
  const listen = deps.listen ?? DEFAULT_DEPS.listen;

  // Active workspace for workspace-gated prompt display. Prompts for an
  // inactive workspace are silently deferred until the user activates it.
  const activeWorkspaceId = useActiveStore((s) => s.activeWorkspaceId);

  // Workspace-active filtering: only show a prompt when either it has no
  // workspaceId (global/legacy), no workspace is currently active (settings
  // view etc.), or its workspaceId matches the active one. All other prompts
  // stay queued until the user switches to that workspace (no focus stealing).
  const currentPrompt = useMemo<SshAuthPrompt | null>(() => {
    if (rawCurrentPrompt === null) return null;
    // No workspaceId: show immediately (legacy / non-workspace prompt).
    if (!rawCurrentPrompt.workspaceId) return rawCurrentPrompt;
    // No workspace active (e.g. settings panel): show any prompt to avoid
    // indefinitely hiding prompts when no workspace is in focus.
    if (activeWorkspaceId === null) return rawCurrentPrompt;
    // Has workspaceId: only show when that workspace is active.
    if (rawCurrentPrompt.workspaceId === activeWorkspaceId) return rawCurrentPrompt;
    // rawCurrentPrompt is for an inactive workspace — look for an alternative
    // prompt in the queue that matches the active workspace (or has no id).
    const activePrompt = pendingPrompts.find(
      (p) => !p.workspaceId || p.workspaceId === activeWorkspaceId,
    );
    return activePrompt ?? null;
  }, [rawCurrentPrompt, activeWorkspaceId, pendingPrompts]);

  useEffect(() => {
    const dispose = installSshAuthPromptListeners(listen);
    // A prompt broadcast that fired before this listener mounted — e.g. an
    // SSH workspace reconnecting during app startup, before the window
    // existed — is not buffered by main. Pull any already-pending prompts
    // once on mount; enqueuePrompt dedupes by promptId, so a prompt also
    // delivered live by the listener is not double-queued.
    void call("sshAuth", "pending", undefined)
      .then((result) => {
        // ipcCallResult returns IpcResult — branch on result.ok.
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
      // Fire-and-forget: send auth response to main; errors logged only.
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
    // Fire-and-forget: send host-key trust decision to main; errors logged only.
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
    // Fire-and-forget: cancel prompt in main; errors logged only.
    void call("sshAuth", "cancel", { promptId: prompt.promptId }).then((result) => {
      if (!result.ok) log.error(`prompt cancel failed: ${result.message}`);
    });
  }, [call, currentPrompt]);

  // Reattach indicator: a prompt is "for reattach" when its workspace was
  // in held state when the prompt arrived (tracked via pty.held events).
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

/** Test-only reset helper for the module-level prompt store. */
export function __resetSshAuthPromptsForTests(): void {
  promptQueue = [];
  promptSnapshot = EMPTY_SNAPSHOT;
  heldWorkspaceIds.clear();
  notifySubscribers();
}

/** Test-only: mark a workspace as having held PTY sessions. */
export function __markWorkspaceHeldForTests(workspaceId: string): void {
  heldWorkspaceIds.add(workspaceId);
}

/** Test-only: clear held workspace tracking. */
export function __clearHeldWorkspacesForTests(): void {
  heldWorkspaceIds.clear();
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

/** Notifies React external-store subscribers. */
function notifySubscribers(): void {
  for (const subscriber of subscribers) subscriber();
}
