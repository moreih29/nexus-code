// src/renderer/state/stores/terminal.ts — Terminal user-settings store.
//
// Mirrors the pattern established by state/stores/theme.ts and
// state/stores/density.ts.
//
// Persistence model:
//   - appState (main process, via IPC) — authoritative store.
//
// Fields (all optional, undefined = token fallback):
//   - fontSize:      token fallback = typeScale.codeUi.fontSize
//   - cursorStyle:   token fallback = 'block'
//   - fontFamily:    token fallback = fontFamily.monoDisplay
//   - fontLigatures: token fallback = false
//
// fontFamily/fontLigatures are INDEPENDENT of the editor font store — the
// terminal owns its own typeface preferences.
//
// Mutation side-effects (per setter):
//   1. Zustand state update.
//   2. Fire-and-forget IPC write to appState.
//   3. Dispatch CustomEvent 'nexus:terminal-settings-changed' on window so
//      open TerminalController instances re-apply the new settings.

import { create } from "zustand";
import { fontFamily, typeScale } from "../../../shared/design-tokens";
import { createLogger } from "../../../shared/log/renderer";
import { ipcCallResult } from "../../ipc/client";

const log = createLogger("terminal");

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
  fontFamily: string | undefined;
  fontLigatures: boolean | undefined;

  /** Hydrate from persisted appState — called once during bootstrap. */
  hydrate(values: {
    fontSize?: TerminalFontSize | undefined;
    cursorStyle?: TerminalCursorStyle | undefined;
    fontFamily?: string | undefined;
    fontLigatures?: boolean | undefined;
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

  /**
   * Set the terminal font family (independent of the editor font).
   * Persists to appState + dispatches 'nexus:terminal-settings-changed'.
   */
  setFontFamily(value: string | undefined): void;

  /**
   * Toggle terminal font ligatures (independent of the editor font).
   * Persists to appState + dispatches 'nexus:terminal-settings-changed'.
   */
  setFontLigatures(value: boolean | undefined): void;
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
    fontFamily: undefined,
    fontLigatures: undefined,

    hydrate({ fontSize, cursorStyle, fontFamily: family, fontLigatures }) {
      set({ fontSize, cursorStyle, fontFamily: family, fontLigatures });
    },

    setFontSize(value) {
      set({ fontSize: value });

      void ipcCallResult("appState", "set", {
        terminalFontSize: value,
      }).then((result) => {
        if (!result.ok) log.warn(`appState set (fontSize) failed: ${result.message}`);
      });

      dispatchSettingsChanged();
    },

    setCursorStyle(value) {
      set({ cursorStyle: value });

      void ipcCallResult("appState", "set", {
        terminalCursorStyle: value,
      }).then((result) => {
        if (!result.ok) log.warn(`appState set (cursorStyle) failed: ${result.message}`);
      });

      dispatchSettingsChanged();
    },

    setFontFamily(value) {
      set({ fontFamily: value });

      void ipcCallResult("appState", "set", {
        terminalFontFamily: value,
      }).then((result) => {
        if (!result.ok) log.warn(`appState set (fontFamily) failed: ${result.message}`);
      });

      dispatchSettingsChanged();
    },

    setFontLigatures(value) {
      set({ fontLigatures: value });

      void ipcCallResult("appState", "set", {
        terminalFontLigatures: value,
      }).then((result) => {
        if (!result.ok) log.warn(`appState set (fontLigatures) failed: ${result.message}`);
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

/**
 * Resolve the effective font family. User override (if set) is prepended to
 * the mono fallback chain so an unavailable custom face degrades gracefully;
 * undefined falls back to the design token's mono stack.
 */
export function resolvedTerminalFontFamily(): string {
  const { fontFamily: family } = useTerminalStore.getState();
  if (family && family.trim() !== "") {
    return `"${family}", ${fontFamily.monoDisplay}`;
  }
  return fontFamily.monoDisplay;
}

/** Resolve the effective ligatures toggle: store value or fallback false. */
export function resolvedTerminalFontLigatures(): boolean {
  const { fontLigatures } = useTerminalStore.getState();
  return fontLigatures ?? false;
}
