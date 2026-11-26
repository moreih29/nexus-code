import { type Dispatch, type SetStateAction, useEffect, useMemo } from "react";
import { create } from "zustand";
import type { ComposerAttachment, ComposerContents } from "../../components/chat/composer";
import { canRestoreFailedDraft } from "../chat/composer-submit";
import type { ImageBlock } from "../chat/model";
import type { ComposerDraft } from "../chat/store";

interface PeerChat {
  deviceId: string;
  workspaceId: string;
  tabId: string;
}

const keyOf = ({ deviceId, workspaceId, tabId }: PeerChat) => `${deviceId}:${workspaceId}:${tabId}`;

const empty: ComposerContents = { text: "", images: [], files: [] };

const usePeerDrafts = create<{
  drafts: Readonly<Record<string, ComposerDraft>>;
  contents: Readonly<Record<string, ComposerContents>>;
}>(() => ({ drafts: {}, contents: {} }));

export function putPeerDraft(chat: PeerChat, text: string, images: ImageBlock[] = []): void {
  usePeerDrafts.setState((s) => ({
    drafts: { ...s.drafts, [keyOf(chat)]: { text, images, nonce: Date.now() } },
  }));
}

export function clearPeerDraft(chat: PeerChat): void {
  const key = keyOf(chat);
  if (!(key in usePeerDrafts.getState().drafts)) return;
  usePeerDrafts.setState((s) => {
    const { [key]: _taken, ...rest } = s.drafts;
    return { drafts: rest };
  });
}

export function peerDraftOf(chat: PeerChat): ComposerDraft | undefined {
  return usePeerDrafts.getState().drafts[keyOf(chat)];
}

export function usePeerDraft(chat: PeerChat): ComposerDraft | undefined {
  return usePeerDrafts((s) => s.drafts[keyOf(chat)]);
}

export function applyPeerDraft(chat: PeerChat): void {
  const key = keyOf(chat);
  usePeerDrafts.setState((state) => {
    const { [key]: draft, ...drafts } = state.drafts;
    if (!draft) return state;
    const current = state.contents[key] ?? empty;
    return {
      drafts,
      contents: {
        ...state.contents,
        [key]: {
          text: [current.text, draft.text].filter(Boolean).join("\n"),
          images: [...current.images, ...draft.images],
          files: current.files,
        },
      },
    };
  });
}

export function restorePeerComposition(
  chat: PeerChat,
  draft: { text: string; images: ImageBlock[]; files: readonly ComposerAttachment[] },
  onlyIfEmpty = false,
): boolean {
  const key = keyOf(chat);
  let restored = false;
  usePeerDrafts.setState((state) => {
    const current = state.contents[key] ?? empty;
    if (onlyIfEmpty && (state.drafts[key] || !canRestoreFailedDraft(current, "failed")))
      return state;
    restored = true;
    return {
      contents: {
        ...state.contents,
        [key]: {
          text: [current.text, draft.text].filter(Boolean).join("\n"),
          images: [...current.images, ...draft.images],
          files: [...current.files, ...draft.files],
        },
      },
    };
  });
  return restored;
}

export function peerContentsOf(chat: PeerChat): ComposerContents {
  return usePeerDrafts.getState().contents[keyOf(chat)] ?? empty;
}

function setContents<K extends keyof ComposerContents>(
  key: string,
  field: K,
  action: SetStateAction<ComposerContents[K]>,
): void {
  usePeerDrafts.setState((state) => {
    const current = state.contents[key] ?? empty;
    const update = typeof action === "function" ? action(current[field]) : action;
    if (update === current[field]) return state;
    const next = { ...current, [field]: update };
    if (next.text || next.images.length > 0 || next.files.length > 0) {
      return { contents: { ...state.contents, [key]: next } };
    }
    const { [key]: _empty, ...contents } = state.contents;
    return { contents };
  });
}

export function clearPeerComposition(chat: PeerChat, draft: ComposerContents): void {
  const key = keyOf(chat);
  usePeerDrafts.setState((state) => {
    if (state.contents[key] !== draft) return state;
    const { [key]: _submitted, ...contents } = state.contents;
    return { contents };
  });
}

export function usePeerComposition(chat: PeerChat): ComposerContents & {
  setText: Dispatch<SetStateAction<string>>;
  setImages: Dispatch<SetStateAction<ImageBlock[]>>;
  setFiles: Dispatch<SetStateAction<ComposerAttachment[]>>;
  current(): ComposerContents;
  clearSubmitted(draft: ComposerContents): void;
} {
  const { deviceId, workspaceId, tabId } = chat;
  const key = keyOf(chat);
  const draft = usePeerDraft(chat);
  const contents = usePeerDrafts((state) => state.contents[key] ?? empty);
  useEffect(() => {
    if (draft) applyPeerDraft({ deviceId, workspaceId, tabId });
  }, [deviceId, workspaceId, tabId, draft]);
  const setters = useMemo(
    () => ({
      setText: (action: SetStateAction<string>) => setContents(key, "text", action),
      setImages: (action: SetStateAction<ImageBlock[]>) => setContents(key, "images", action),
      setFiles: (action: SetStateAction<ComposerAttachment[]>) => setContents(key, "files", action),
      current: () => usePeerDrafts.getState().contents[key] ?? empty,
      clearSubmitted: (draft: ComposerContents) =>
        clearPeerComposition({ deviceId, workspaceId, tabId }, draft),
    }),
    [deviceId, workspaceId, tabId, key],
  );
  return { ...contents, ...setters };
}
