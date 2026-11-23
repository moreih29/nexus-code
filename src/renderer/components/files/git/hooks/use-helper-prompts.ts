import i18next from "i18next";
import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import type { AskpassPrompt, GitEditorPrompt } from "../../../../../shared/git/types";
import { createLogger } from "../../../../../shared/log/renderer";
import { ipcCallResult, ipcListen } from "../../../../ipc/client";

export interface GitHelperPromptSnapshot {
  readonly pendingCredentialPrompts: readonly AskpassPrompt[];
  readonly pendingEditorPrompts: readonly GitEditorPrompt[];
  readonly credentialPrompt: AskpassPrompt | null;
  readonly editorPrompt: GitEditorPrompt | null;
}

export interface GitHelperPromptDeps {
  readonly call?: typeof ipcCallResult;
  readonly listen?: typeof ipcListen;
}

const log = createLogger("git");

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
  call: ipcCallResult,
  listen: ipcListen,
};

let promptQueue: readonly GitHelperPromptQueueItem[] = [];
let promptSnapshot: GitHelperPromptSnapshot = EMPTY_PROMPT_SNAPSHOT;
const promptSubscribers = new Set<() => void>();

export function isPromptForWorkspace(
  prompt: { readonly workspaceId?: string },
  workspaceId: string,
): boolean {
  return !prompt.workspaceId || prompt.workspaceId === workspaceId;
}

export function gitHelperOccupancyMessage(args: {
  readonly credentialPrompt: AskpassPrompt | null;
  readonly editorPrompt: GitEditorPrompt | null;
}): string | null {
  if (args.credentialPrompt) return i18next.t("files:git.helperPrompt.awaitingCredentials");
  if (args.editorPrompt) return i18next.t("files:git.helperPrompt.editingCommitMessage");
  return null;
}

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
    return i18next.t("files:git.helperPrompt.awaitingCredentials");
  }
  if (pendingEditorPrompts.some((prompt) => isPromptForWorkspace(prompt, args.workspaceId))) {
    return i18next.t("files:git.helperPrompt.editingCommitMessage");
  }
  return null;
}

export function getGitHelperPromptSnapshot(): GitHelperPromptSnapshot {
  return promptSnapshot;
}

function subscribeGitHelperPromptSnapshot(listener: () => void): () => void {
  promptSubscribers.add(listener);
  return () => {
    promptSubscribers.delete(listener);
  };
}

export function installGitHelperPromptListeners(listen: typeof ipcListen = ipcListen): () => void {
  const unlistenAskpass = listen("askpass", "prompt", (prompt) => {
    enqueuePrompt({ kind: "credential", prompt });
  });
  const unlistenAskpassClosed = listen("askpass", "closed", ({ promptId }) => {
    clearCredentialPrompt(promptId);
  });
  const unlistenEditor = listen("editor", "prompt", (prompt) => {
    enqueuePrompt({ kind: "editor", prompt });
  });
  const unlistenEditorClosed = listen("editor", "closed", ({ promptId }) => {
    clearEditorPrompt(promptId);
  });
  return () => {
    unlistenAskpass();
    unlistenAskpassClosed();
    unlistenEditor();
    unlistenEditorClosed();
  };
}

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
      void call("askpass", "respond", { promptId: prompt.promptId, value }).then((result) => {
        if (!result.ok) log.error(`credential response failed: ${result.message}`);
      });
    },
    [call, credentialPrompt],
  );

  const cancelCredential = useCallback(() => {
    const prompt = credentialPrompt;
    if (!prompt) return;
    clearCredentialPrompt(prompt.promptId);
    void call("askpass", "cancel", { promptId: prompt.promptId }).then((result) => {
      if (!result.ok) log.error(`credential cancel failed: ${result.message}`);
    });
  }, [call, credentialPrompt]);

  const saveCommitMessage = useCallback(
    (content: string) => {
      const prompt = editorPrompt;
      if (!prompt) return;
      clearEditorPrompt(prompt.promptId);
      void call("editor", "save", { promptId: prompt.promptId, content }).then((result) => {
        if (!result.ok) log.error(`commit message save failed: ${result.message}`);
      });
    },
    [call, editorPrompt],
  );

  const cancelCommitMessage = useCallback(() => {
    const prompt = editorPrompt;
    if (!prompt) return;
    clearEditorPrompt(prompt.promptId);
    void call("editor", "cancel", { promptId: prompt.promptId }).then((result) => {
      if (!result.ok) log.error(`commit message cancel failed: ${result.message}`);
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

export function __resetGitHelperPromptsForTests(): void {
  promptQueue = [];
  promptSnapshot = EMPTY_PROMPT_SNAPSHOT;
  notifyPromptSubscribers();
}

function useGitHelperPromptSnapshot(): GitHelperPromptSnapshot {
  return useSyncExternalStore(
    subscribeGitHelperPromptSnapshot,
    getGitHelperPromptSnapshot,
    getGitHelperPromptSnapshot,
  );
}

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

function updatePromptQueue(
  update: (current: readonly GitHelperPromptQueueItem[]) => readonly GitHelperPromptQueueItem[],
): void {
  const nextQueue = update(promptQueue);
  if (nextQueue === promptQueue) return;
  promptQueue = nextQueue;
  promptSnapshot = createPromptSnapshot(nextQueue);
  notifyPromptSubscribers();
}

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

function clearCredentialPrompt(promptId: string): void {
  updatePromptQueue((current) =>
    current.filter((item) => item.kind !== "credential" || item.prompt.promptId !== promptId),
  );
}

function clearEditorPrompt(promptId: string): void {
  updatePromptQueue((current) =>
    current.filter((item) => item.kind !== "editor" || item.prompt.promptId !== promptId),
  );
}

function notifyPromptSubscribers(): void {
  for (const listener of [...promptSubscribers]) listener();
}
