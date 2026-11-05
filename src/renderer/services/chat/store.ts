import { create } from "zustand";
import { type ChatModel, emptyModel, type ImageBlock } from "./model";

/**
 * Where a tab's program stands:
 * - starting: being started, or its log replayed;
 * - ready: running;
 * - held: the workspace's connection dropped; the program may still run;
 * - ended: it exited, or ran on an agent that is gone; sending starts it again;
 * - not-found: claude is not installed where the workspace runs;
 * - failed: it could not be started.
 */
export type ChatPhase = "idle" | "starting" | "ready" | "held" | "ended" | "not-found" | "failed";

export interface QueuedMessage {
  id: string;
  text: string;
  images: ImageBlock[];
}

/** Text the app puts in the composer: a rewound or forked message. */
export interface ComposerDraft {
  text: string;
  images: ImageBlock[];
  /** Changes with each draft, so the same text twice is still put in. */
  nonce: number;
}

export interface ChatTabState {
  phase: ChatPhase;
  error?: string;
  model: ChatModel;
  /** What the tab showed before its program's log: a transcript, an earlier agent's log. */
  history: ChatModel | null;
  /** Messages the app holds until the turn ends (⌘↩). */
  queue: QueuedMessage[];
  /** `claude --version` where the program runs. */
  version: string | null;
  /** The log dropped its oldest lines. */
  truncated: boolean;
  draft?: ComposerDraft;
  /** An MCP server's sign-in under way in the browser. */
  mcpSignIn?: McpSignIn;
}

export interface McpSignIn {
  serverName: string;
  /** The page the browser was sent to, to open again. */
  authUrl: string;
  /** The page on this machine the browser comes back to (main's oauth callbacks). */
  callbackId: string;
}

export function emptyTabState(): ChatTabState {
  return {
    phase: "idle",
    model: emptyModel(),
    history: null,
    queue: [],
    version: null,
    truncated: false,
  };
}

interface ChatStore {
  tabs: Record<string, ChatTabState>;
  update: (key: string, update: (prev: ChatTabState) => ChatTabState) => void;
  remove: (key: string) => void;
}

export const useChatStore = create<ChatStore>((set) => ({
  tabs: {},
  update: (key, update) =>
    set((state) => ({
      tabs: { ...state.tabs, [key]: update(state.tabs[key] ?? emptyTabState()) },
    })),
  remove: (key) =>
    set((state) => {
      if (!(key in state.tabs)) return state;
      const { [key]: _removed, ...rest } = state.tabs;
      return { tabs: rest };
    }),
}));

export function chatKey(workspaceId: string, tabId: string): string {
  return `${workspaceId}:${tabId}`;
}

export function useChatTab(workspaceId: string, tabId: string): ChatTabState {
  return useChatStore((state) => state.tabs[chatKey(workspaceId, tabId)] ?? EMPTY);
}

const EMPTY = emptyTabState();
