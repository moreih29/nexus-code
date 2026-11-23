import { type Dispatch, type SetStateAction, useEffect, useMemo } from "react";
import { create } from "zustand";
import type { ComposerAttachment } from "../../components/chat/composer";
import type { ImageBlock } from "../chat/model";
import type { ComposerDraft } from "../chat/store";

interface PeerChat {
  deviceId: string;
  workspaceId: string;
  tabId: string;
}

const keyOf = ({ deviceId, workspaceId, tabId }: PeerChat) => `${deviceId}:${workspaceId}:${tabId}`;

type Contents = Pick<ComposerDraft, "text" | "images"> & { files: ComposerAttachment[] };
const empty: Contents = { text: "", images: [], files: [] };

const usePeerDrafts = create<{
  drafts: Readonly<Record<string, ComposerDraft>>;
  contents: Readonly<Record<string, Contents>>;
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
): void {
  const key = keyOf(chat);
  usePeerDrafts.setState((state) => {
    const current = state.contents[key] ?? empty;
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
}

export function peerContentsOf(chat: PeerChat): Contents {
  return usePeerDrafts.getState().contents[keyOf(chat)] ?? empty;
}

function setContents<K extends keyof Contents>(
  key: string,
  field: K,
  action: SetStateAction<Contents[K]>,
): void {
  usePeerDrafts.setState((state) => {
    const current = state.contents[key] ?? empty;
    const update = typeof action === "function" ? action(current[field]) : action;
    const next = { ...current, [field]: update };
    if (next.text || next.images.length > 0 || next.files.length > 0) {
      return { contents: { ...state.contents, [key]: next } };
    }
    const { [key]: _empty, ...contents } = state.contents;
    return { contents };
  });
}

export function usePeerComposition(chat: PeerChat): Contents & {
  setText: Dispatch<SetStateAction<string>>;
  setImages: Dispatch<SetStateAction<ImageBlock[]>>;
  setFiles: Dispatch<SetStateAction<ComposerAttachment[]>>;
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
    }),
    [key],
  );
  return { ...contents, ...setters };
}
