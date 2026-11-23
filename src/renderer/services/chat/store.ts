import { useSyncExternalStore } from "react";
import { create } from "zustand";
import { type ChatModel, emptyModel, type ImageBlock } from "./model";
import type { QueuedMessage } from "./transport/queue";
import type { PeerSubmission } from "./transport/submission";

export type ChatPhase = "idle" | "starting" | "ready" | "held" | "ended" | "not-found" | "failed";

export interface ComposerDraft {
  text: string;
  images: ImageBlock[];
  nonce: number;
}

export interface ChatTabState {
  phase: ChatPhase;
  phaseRevision?: number;
  error?: string;
  model: ChatModel;
  history: ChatModel | null;
  historyPage?: { hasEarlier: boolean; loading: boolean };
  queue: QueuedMessage[];
  cancelledSubmissions?: readonly string[];
  peerSubmissions?: Readonly<Record<string, PeerSubmission>>;

  version: string | null;
  truncated: boolean;
  draft?: ComposerDraft;
  mcpSignIn?: McpSignIn;
  card?: CommandCard;
  reveal?: Reveal;
  goalClosed?: string;
}

export type RevealPart = "context" | "usage" | "mcp" | "model" | "effort" | "status" | "jobs";

export interface Reveal {
  part: RevealPart;
  id?: string;
  seq: number;
}

export interface CommandCard {
  id: string;
  title: string;
  text?: string;
  files?: { path: string; label: string }[];
  sections?: CardSection[];
  loading?: boolean;
  error?: string;
}

export interface CardSection {
  title: string;
  rows: CardRow[];
  empty: string;
}

export interface CardRow {
  id: string;
  label: string;
  detail?: string;
  actions: { label: string; run: () => void }[];
}

export interface McpSignIn {
  serverName: string;
  authUrl: string;
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

export const unseenSends = new Map<string, { before: number }>();

let phaseRevision = 0;

export const useChatStore = create<ChatStore>((set) => ({
  tabs: {},
  update: (key, update) =>
    set((state) => {
      const prev = state.tabs[key] ?? emptyTabState();
      const next = update(prev);
      const phaseChanged = prev.phase !== next.phase || prev.error !== next.error;
      if (phaseChanged) phaseRevision = Math.max(Date.now(), phaseRevision + 1);
      const revision = phaseChanged ? phaseRevision : prev.phaseRevision;
      return {
        tabs: {
          ...state.tabs,
          [key]:
            revision !== undefined && revision !== next.phaseRevision
              ? { ...next, phaseRevision: revision }
              : next,
        },
      };
    }),
  remove: (key) => {
    unseenSends.delete(key);
    set((state) => {
      if (!(key in state.tabs)) return state;
      const { [key]: _removed, ...rest } = state.tabs;
      return { tabs: rest };
    });
  },
}));

export function revealPart(key: string, part: RevealPart, id?: string): void {
  useChatStore.getState().update(key, (prev) => ({
    ...prev,
    reveal: { part, ...(id ? { id } : {}), seq: (prev.reveal?.seq ?? 0) + 1 },
  }));
}

export function takeReveal(key: string, seq: number): void {
  if (!(key in useChatStore.getState().tabs)) return;
  useChatStore.getState().update(key, (prev) => {
    if (prev.reveal?.seq !== seq) return prev;
    const { reveal: _done, ...rest } = prev;
    return rest;
  });
}

export function chatKey(workspaceId: string, tabId: string): string {
  return `${workspaceId}:${tabId}`;
}

export function useChatTab(workspaceId: string, tabId: string, shown = true): ChatTabState {
  const key = chatKey(workspaceId, tabId);
  return useSyncExternalStore(
    shown ? useChatStore.subscribe : followNothing,
    () => useChatStore.getState().tabs[key] ?? EMPTY,
  );
}

function followNothing(): () => void {
  return () => {};
}

const EMPTY = emptyTabState();
