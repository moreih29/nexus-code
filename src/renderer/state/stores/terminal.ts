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
//   - shell:         fallback = the system default shell (resolved in main)
//   - customShells:  the shells the user added, besides the detected ones
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
import type { CustomShell, ShellChoice } from "../../../shared/pty/shell";
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
  /** The shell new local terminals open with; main reads it at each spawn. */
  shell: ShellChoice | undefined;
  /** Shells the user added in Settings › Terminal; main reads them at each spawn. */
  customShells: CustomShell[];

  /** Hydrate from persisted appState — called once during bootstrap. */
  hydrate(values: {
    fontSize?: TerminalFontSize | undefined;
    cursorStyle?: TerminalCursorStyle | undefined;
    fontFamily?: string | undefined;
    fontLigatures?: boolean | undefined;
    shell?: ShellChoice | undefined;
    customShells?: CustomShell[] | undefined;
  }): void;

  /**
   * Take the shells another window saved (`appState.terminalShellsChanged`).
   * Does not persist.
   */
  hydrateShells(shells: { shell?: ShellChoice | undefined; customShells: CustomShell[] }): void;

  /**
   * Set the default shell. Persists to appState only: running terminals keep
   * their shell, and main reads the setting when the next one spawns.
   */
  setShell(value: ShellChoice | undefined): void;

  /** Add a shell to the list, or replace the one with its id. Persists to appState. */
  saveCustomShell(shell: CustomShell): void;

  /**
   * Remove a shell from the list. When it was the default shell, the default
   * goes back to the system default.
   */
  removeCustomShell(id: string): void;

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

export const useTerminalStore = create<TerminalSettingsState>((set, get) => {
  const setCustomShells = (list: CustomShell[]) => {
    set({ customShells: list });

    void ipcCallResult("appState", "set", {
      terminalShells: list.length > 0 ? list : undefined,
    }).then((result) => {
      if (!result.ok) log.warn(`appState set (customShells) failed: ${result.message}`);
    });
  };

  return {
    fontSize: undefined,
    cursorStyle: undefined,
    fontFamily: undefined,
    fontLigatures: undefined,
    shell: undefined,
    customShells: [],

    hydrate({ fontSize, cursorStyle, fontFamily: family, fontLigatures, shell, customShells }) {
      set({
        fontSize,
        cursorStyle,
        fontFamily: family,
        fontLigatures,
        shell,
        customShells: customShells ?? [],
      });
    },

    hydrateShells({ shell, customShells }) {
      set({ shell, customShells });
    },

    setShell(value) {
      set({ shell: value });

      void ipcCallResult("appState", "set", {
        terminalShell: value,
      }).then((result) => {
        if (!result.ok) log.warn(`appState set (shell) failed: ${result.message}`);
      });
    },

    saveCustomShell(shell) {
      const list = get().customShells;
      setCustomShells(
        list.some((s) => s.id === shell.id)
          ? list.map((s) => (s.id === shell.id ? shell : s))
          : [...list, shell],
      );
    },

    removeCustomShell(id) {
      setCustomShells(get().customShells.filter((s) => s.id !== id));
      const { shell, setShell } = get();
      if (shell?.kind === "custom" && shell.id === id) setShell(undefined);
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
