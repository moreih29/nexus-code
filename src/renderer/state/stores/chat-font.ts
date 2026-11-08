/**
 * The chat tabs' text, as Settings › Agent sets it: a size and a font, each
 * undefined for the app's own. Persisted in AppState; a tab carries them as
 * CSS custom properties on its root (useChatFontStyle).
 */

import { type CSSProperties, useMemo } from "react";
import { create } from "zustand";
import { createLogger } from "../../../shared/log/renderer";
import type { AppState } from "../../../shared/types/app-state";
import { ipcCallResult } from "../../ipc/client";
import { chatFontVars, isChatFontFamily, isChatFontSize } from "../../services/chat/chat-font";

const log = createLogger("chat-font");

interface ChatFontState {
  /** The replies' size in px; undefined = CHAT_FONT_SIZE. */
  size: number | undefined;
  /** The font, as CSS names it; undefined = the app's. */
  family: string | undefined;
  hydrate(state: Partial<Pick<AppState, "chatFontSize" | "chatFontFamily">>): void;
  setSize(size: number | undefined): void;
  setFamily(family: string | undefined): void;
}

function persist(patch: Partial<AppState>): void {
  void ipcCallResult("appState", "set", patch).then((result) => {
    if (!result.ok) log.warn(`appState set (chat font) failed: ${result.message}`);
  });
}

export const useChatFontStore = create<ChatFontState>((set) => ({
  size: undefined,
  family: undefined,

  hydrate(state) {
    set({
      size: isChatFontSize(state.chatFontSize) ? state.chatFontSize : undefined,
      family: isChatFontFamily(state.chatFontFamily) ? state.chatFontFamily : undefined,
    });
  },

  setSize(size) {
    const next = isChatFontSize(size) ? size : undefined;
    set({ size: next });
    persist({ chatFontSize: next });
  },

  setFamily(family) {
    const next = isChatFontFamily(family) ? family : undefined;
    set({ family: next });
    persist({ chatFontFamily: next });
  },
}));

/** The style a chat tab's root takes (with the `chat-font` class) for its text. */
export function useChatFontStyle(): CSSProperties {
  const size = useChatFontStore((s) => s.size);
  const family = useChatFontStore((s) => s.family);
  return useMemo(() => chatFontVars(size, family) as CSSProperties, [size, family]);
}
