/**
 * Renderer hook for Git helper prompts.
 *
 * It listens to askpass/editor broadcasts, keeps a single FIFO of pending
 * prompts, and sends renderer responses back through the typed IPC contract.
 */
import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import type { AskpassPrompt, GitEditorPrompt } from "../../../../shared/types/git";
import { ipcCall, ipcListen } from "../../../ipc/client";

export interface GitHelperPromptSnapshot {
  readonly pendingCredentialPrompts: readonly AskpassPrompt[];
  readonly pendingEditorPrompts: readonly GitEditorPrompt[];
  readonly credentialPrompt: AskpassPrompt | null;
  readonly editorPrompt: GitEditorPrompt | null;
}

export interface GitHelperPromptDeps {
  readonly call?: typeof ipcCall;
  readonly listen?: typeof ipcListen;
}

export interface GitHelperPromptState {
  readonly credentialPrompt: AskpassPrompt | null;
  readonly editorPrompt: GitEditorPrompt | null;
  readonly occupancyMessage: string | null;
  readonly respondCredential: (value: string) => void;
  readonly cancelCredential: () => void;
  readonly saveCommitMessage: (content: string) => void;
  readonly cancelCommitMessage: () => void;
}

type GitHelperPromptQueueItem =
  | {
      readonly kind: "credential";
      readonly prompt: AskpassPrompt;
    }
  | {
      readonly kind: "editor";
      readonly prompt: GitEditorPrompt;
    };

const EMPTY_PROMPT_SNAPSHOT: GitHelperPromptSnapshot = {
  pendingCredentialPrompts: [],
  pendingEditorPrompts: [],
  credentialPrompt: null,
  editorPrompt: null,
};
const DEFAULT_PROMPT_DEPS: Required<GitHelperPromptDeps> = {
  call: ipcCall,
  listen: ipcListen,
};

let promptQueue: readonly GitHelperPromptQueueItem[] = [];
let promptSnapshot: GitHelperPromptSnapshot = EMPTY_PROMPT_SNAPSHOT;
const promptSubscribers = new Set<() => void>();

/**
 * Returns true when a helper prompt belongs to this GitPanel's workspace.
 * Prompts without a workspace id are accepted as process-wide fallbacks.
 */
export function isPromptForWorkspace(
  prompt: { readonly workspaceId?: string },
  workspaceId: string,
): boolean {
  return !prompt.workspaceId || prompt.workspaceId === workspaceId;
}

/**
 * Computes the queue-occupancy banner copy from currently active helper
 * prompts.
 */
export function gitHelperOccupancyMessage(args: {
  readonly credentialPrompt: AskpassPrompt | null;
  readonly editorPrompt: GitEditorPrompt | null;
}): string | null {
  if (args.credentialPrompt) return "Awaiting credentials…";
  if (args.editorPrompt) return "Editing commit message…";
  return null;
}

/**
 * Computes the panel-local queue-occupancy banner from the globally active
 * prompt snapshot without installing another renderer IPC listener.
 */
export function gitHelperOccupancyMessageForWorkspace(args: {
  readonly workspaceId: string;
  readonly pendingCredentialPrompts?: readonly AskpassPrompt[];
  readonly pendingEditorPrompts?: readonly GitEditorPrompt[];
  readonly credentialPrompt: AskpassPrompt | null;
  readonly editorPrompt: GitEditorPrompt | null;
}): string | null {
  const pendingCredentialPrompts =
    args.pendingCredentialPrompts ?? (args.credentialPrompt ? [args.credentialPrompt] : []);
  const pendingEditorPrompts =
    args.pendingEditorPrompts ?? (args.editorPrompt ? [args.editorPrompt] : []);

  if (pendingCredentialPrompts.some((prompt) => isPromptForWorkspace(prompt, args.workspaceId))) {
    return "Awaiting credentials…";
  }
  if (pendingEditorPrompts.some((prompt) => isPromptForWorkspace(prompt, args.workspaceId))) {
    return "Editing commit message…";
  }
  return null;
}

/**
 * Returns the current global helper prompt snapshot for tests and external
 * store subscriptions.
 */
export function getGitHelperPromptSnapshot(): GitHelperPromptSnapshot {
  return promptSnapshot;
}

/**
 * Subscribes to global helper prompt state. This is intentionally separate
 * from renderer IPC broadcasts so Source Control panels can show occupancy
 * banners without becoming additional askpass/editor response owners.
 */
export function subscribeGitHelperPromptSnapshot(listener: () => void): () => void {
  promptSubscribers.add(listener);
  return () => {
    promptSubscribers.delete(listener);
  };
}

/**
 * Installs the single renderer listener pair for Git helper prompts.
 */
export function installGitHelperPromptListeners(listen: typeof ipcListen = ipcListen): () => void {
  const unlistenAskpass = listen("askpass", "prompt", (prompt) => {
    enqueuePrompt({ kind: "credential", prompt });
  });
  const unlistenEditor = listen("editor", "prompt", (prompt) => {
    enqueuePrompt({ kind: "editor", prompt });
  });
  return () => {
    unlistenAskpass();
    unlistenEditor();
  };
}

/**
 * Source Control panel hook for showing the helper prompt queue-occupancy
 * banner. It observes global prompt state and does not register IPC listeners.
 */
export function useGitHelperOccupancy(workspaceId: string): string | null {
  const snapshot = useGitHelperPromptSnapshot();
  return useMemo(
    () =>
      gitHelperOccupancyMessageForWorkspace({
        workspaceId,
        pendingCredentialPrompts: snapshot.pendingCredentialPrompts,
        pendingEditorPrompts: snapshot.pendingEditorPrompts,
        credentialPrompt: snapshot.credentialPrompt,
        editorPrompt: snapshot.editorPrompt,
      }),
    [snapshot, workspaceId],
  );
}

/**
 * Installs global prompt listeners and owns the only renderer response path.
 * Mount once from GlobalRoots so clone prompts work without GitPanel mounted.
 */
export function useGitHelperPrompts(
  deps: GitHelperPromptDeps = DEFAULT_PROMPT_DEPS,
): GitHelperPromptState {
  const { credentialPrompt, editorPrompt } = useGitHelperPromptSnapshot();
  const call = deps.call ?? DEFAULT_PROMPT_DEPS.call;
  const listen = deps.listen ?? DEFAULT_PROMPT_DEPS.listen;

  useEffect(() => installGitHelperPromptListeners(listen), [listen]);

  const respondCredential = useCallback(
    (value: string) => {
      const prompt = credentialPrompt;
      if (!prompt) return;
      clearCredentialPrompt(prompt.promptId);
      call("askpass", "respond", { promptId: prompt.promptId, value }).catch((error) => {
        console.error("[git] credential response failed", error);
      });
    },
    [call, credentialPrompt],
  );

  const cancelCredential = useCallback(() => {
    const prompt = credentialPrompt;
    if (!prompt) return;
    clearCredentialPrompt(prompt.promptId);
    call("askpass", "cancel", { promptId: prompt.promptId }).catch((error) => {
      console.error("[git] credential cancel failed", error);
    });
  }, [call, credentialPrompt]);

  const saveCommitMessage = useCallback(
    (content: string) => {
      const prompt = editorPrompt;
      if (!prompt) return;
      clearEditorPrompt(prompt.promptId);
      call("editor", "save", { promptId: prompt.promptId, content }).catch((error) => {
        console.error("[git] commit message save failed", error);
      });
    },
    [call, editorPrompt],
  );

  const cancelCommitMessage = useCallback(() => {
    const prompt = editorPrompt;
    if (!prompt) return;
    clearEditorPrompt(prompt.promptId);
    call("editor", "cancel", { promptId: prompt.promptId }).catch((error) => {
      console.error("[git] commit message cancel failed", error);
    });
  }, [call, editorPrompt]);

  const occupancyMessage = useMemo(
    () => gitHelperOccupancyMessage({ credentialPrompt, editorPrompt }),
    [credentialPrompt, editorPrompt],
  );

  return {
    credentialPrompt,
    editorPrompt,
    occupancyMessage,
    respondCredential,
    cancelCredential,
    saveCommitMessage,
    cancelCommitMessage,
  };
}

/**
 * Test-only reset helper. Production code should let the helper lifecycle
 * update prompt state through IPC broadcasts and user responses.
 */
export function __resetGitHelperPromptsForTests(): void {
  promptQueue = [];
  promptSnapshot = EMPTY_PROMPT_SNAPSHOT;
  notifyPromptSubscribers();
}

/**
 * Reads the global helper prompt snapshot from React safely.
 */
function useGitHelperPromptSnapshot(): GitHelperPromptSnapshot {
  return useSyncExternalStore(
    subscribeGitHelperPromptSnapshot,
    getGitHelperPromptSnapshot,
    getGitHelperPromptSnapshot,
  );
}

/**
 * Adds a helper prompt to the FIFO, replacing duplicate prompt ids in place so
 * a retransmitted broadcast cannot create two response opportunities.
 */
function enqueuePrompt(nextItem: GitHelperPromptQueueItem): void {
  updatePromptQueue((current) => {
    const duplicateIndex = current.findIndex(
      (item) => item.kind === nextItem.kind && item.prompt.promptId === nextItem.prompt.promptId,
    );
    if (duplicateIndex === -1) return [...current, nextItem];

    const next = [...current];
    next[duplicateIndex] = nextItem;
    return next;
  });
}

/**
 * Applies an atomic prompt-queue update and rebuilds the active snapshot from
 * the first pending item.
 */
function updatePromptQueue(
  update: (current: readonly GitHelperPromptQueueItem[]) => readonly GitHelperPromptQueueItem[],
): void {
  const nextQueue = update(promptQueue);
  if (nextQueue === promptQueue) return;
  promptQueue = nextQueue;
  promptSnapshot = createPromptSnapshot(nextQueue);
  notifyPromptSubscribers();
}

/**
 * Creates the public snapshot while preserving the existing active prompt
 * fields consumed by the dialog components.
 */
function createPromptSnapshot(queue: readonly GitHelperPromptQueueItem[]): GitHelperPromptSnapshot {
  const activePrompt = queue[0] ?? null;
  return {
    pendingCredentialPrompts: queue
      .filter((item) => item.kind === "credential")
      .map((item) => item.prompt),
    pendingEditorPrompts: queue.filter((item) => item.kind === "editor").map((item) => item.prompt),
    credentialPrompt: activePrompt?.kind === "credential" ? activePrompt.prompt : null,
    editorPrompt: activePrompt?.kind === "editor" ? activePrompt.prompt : null,
  };
}

/**
 * Clears a credential prompt by id and promotes the next queued prompt.
 */
function clearCredentialPrompt(promptId: string): void {
  updatePromptQueue((current) =>
    current.filter((item) => item.kind !== "credential" || item.prompt.promptId !== promptId),
  );
}

/**
 * Clears an editor prompt by id and promotes the next queued prompt.
 */
function clearEditorPrompt(promptId: string): void {
  updatePromptQueue((current) =>
    current.filter((item) => item.kind !== "editor" || item.prompt.promptId !== promptId),
  );
}

/**
 * Notifies subscribers outside the live set iteration so unsubscribe during
 * notification cannot skip listeners.
 */
function notifyPromptSubscribers(): void {
  for (const listener of [...promptSubscribers]) listener();
}
