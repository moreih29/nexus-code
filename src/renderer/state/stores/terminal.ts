// src/renderer/state/stores/terminal.ts — Terminal user-settings store.
//
// Mirrors the pattern established by state/stores/theme.ts and
// state/stores/density.ts.
//
// Persistence model:
//   - appState (main process, via IPC) — authoritative store.
//
// Fields (both optional, undefined = token fallback):
//   - fontSize:     token fallback = typeScale.codeUi.fontSize
//   - cursorStyle:  token fallback = 'block'
//
// Mutation side-effects (per setter):
//   1. Zustand state update.
//   2. Fire-and-forget IPC write to appState.
//   3. Dispatch CustomEvent 'nexus:terminal-settings-changed' on window so
//      open TerminalController instances re-apply the new settings.

import { create } from "zustand";
import { typeScale } from "../../../shared/design-tokens";
import { ipcCallResult } from "../../ipc/client";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

// Font size: integer in [8, 32] — matches AppStateSchema.terminalFontSize.
export type TerminalFontSize = number;
export type TerminalCursorStyle = "block" | "underline" | "bar";

// ---------------------------------------------------------------------------
// State shape
// ---------------------------------------------------------------------------

interface TerminalSettingsState {
  fontSize: TerminalFontSize | undefined;
  cursorStyle: TerminalCursorStyle | undefined;

  /** Hydrate from persisted appState — called once during bootstrap. */
  hydrate(values: {
    fontSize?: TerminalFontSize | undefined;
    cursorStyle?: TerminalCursorStyle | undefined;
  }): void;

  /**
   * Set the terminal font size.
   * Persists to appState (authoritative store) + dispatches
   * 'nexus:terminal-settings-changed' so open terminals re-apply.
   */
  setFontSize(value: TerminalFontSize | undefined): void;

  /**
   * Set the terminal cursor style.
   * Persists to appState (authoritative store) + dispatches
   * 'nexus:terminal-settings-changed' so open terminals re-apply.
   */
  setCursorStyle(value: TerminalCursorStyle | undefined): void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function dispatchSettingsChanged(): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("nexus:terminal-settings-changed"));
  }
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useTerminalStore = create<TerminalSettingsState>((set) => {
  return {
    fontSize: undefined,
    cursorStyle: undefined,

    hydrate({ fontSize, cursorStyle }) {
      set({ fontSize, cursorStyle });
    },

    setFontSize(value) {
      set({ fontSize: value });

      void ipcCallResult("appState", "set", {
        terminalFontSize: value,
      }).then((result) => {
        if (!result.ok) console.warn("[terminal] appState set (fontSize) failed", result.message);
      });

      dispatchSettingsChanged();
    },

    setCursorStyle(value) {
      set({ cursorStyle: value });

      void ipcCallResult("appState", "set", {
        terminalCursorStyle: value,
      }).then((result) => {
        if (!result.ok)
          console.warn("[terminal] appState set (cursorStyle) failed", result.message);
      });

      dispatchSettingsChanged();
    },
  };
});

// ---------------------------------------------------------------------------
// Resolved accessors (with token fallback)
// ---------------------------------------------------------------------------

/** Resolve the effective font size: store value or token fallback. */
export function resolvedTerminalFontSize(): number {
  const { fontSize } = useTerminalStore.getState();
  return fontSize ?? typeScale.codeUi.fontSize;
}

/** Resolve the effective cursor style: store value or fallback 'block'. */
export function resolvedTerminalCursorStyle(): TerminalCursorStyle {
  const { cursorStyle } = useTerminalStore.getState();
  return cursorStyle ?? "block";
}
