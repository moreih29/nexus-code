// src/renderer/state/stores/editor-font.ts — Editor font preference store.
//
// Mirrors the pattern established by state/stores/theme.ts and density.ts.
//
// Persistence model:
//   - appState (main process, via IPC) — authoritative store.
//   - localStorage keys below — boot cache, read before React loads.
//
// Semantics: all four fields are optional; undefined = token fallback.
// Each setter dispatches a 'nexus:editor-font-changed' CustomEvent so that
// Monaco instances can hot-apply the new values without a re-mount.

import { create } from "zustand";
import { createLogger } from "../../../shared/log/renderer";
import type { AppState } from "../../../shared/types/app-state";
import { ipcCallResult } from "../../ipc/client";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const log = createLogger("editor-font");

const STORAGE_KEY_SIZE = "editorFontSize";
const STORAGE_KEY_FAMILY = "editorFontFamily";
const STORAGE_KEY_LIGATURES = "editorFontLigatures";
const STORAGE_KEY_LINE_HEIGHT = "editorFontLineHeight";

export const EDITOR_FONT_EVENT = "nexus:editor-font-changed" as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

// Font size: integer in [8, 32] — matches AppStateSchema.editorFontSize.
// Line height: closed set of three steps — matches AppStateSchema.editorFontLineHeight.
export type EditorFontSize = number;
export type EditorFontLineHeight = 1.0 | 1.2 | 1.4;

const EDITOR_FONT_SIZE_MIN = 8;
const EDITOR_FONT_SIZE_MAX = 32;

function isValidEditorFontSize(n: number): boolean {
  return Number.isInteger(n) && n >= EDITOR_FONT_SIZE_MIN && n <= EDITOR_FONT_SIZE_MAX;
}

// ---------------------------------------------------------------------------
// State shape
// ---------------------------------------------------------------------------

interface EditorFontState {
  size: EditorFontSize | undefined;
  family: string | undefined;
  ligatures: boolean | undefined;
  lineHeight: EditorFontLineHeight | undefined;

  /** Hydrate from persisted appState — called once during bootstrap. */
  hydrate(fields: {
    size?: AppState["editorFontSize"];
    family?: AppState["editorFontFamily"];
    ligatures?: AppState["editorFontLigatures"];
    lineHeight?: AppState["editorFontLineHeight"];
  }): void;

  setSize(size: EditorFontSize | undefined): void;
  setFamily(family: string | undefined): void;
  setLigatures(ligatures: boolean | undefined): void;
  setLineHeight(lineHeight: EditorFontLineHeight | undefined): void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function dispatchFontChanged(): void {
  if (typeof window !== "undefined") {
    document.documentElement.dispatchEvent(new CustomEvent(EDITOR_FONT_EVENT, { bubbles: false }));
  }
}

function readStoredSize(): EditorFontSize | undefined {
  if (typeof localStorage === "undefined") return undefined;
  const raw = localStorage.getItem(STORAGE_KEY_SIZE);
  if (raw === null) return undefined;
  const n = Number(raw);
  return isValidEditorFontSize(n) ? n : undefined;
}

function readStoredFamily(): string | undefined {
  if (typeof localStorage === "undefined") return undefined;
  const raw = localStorage.getItem(STORAGE_KEY_FAMILY);
  return raw ?? undefined;
}

function readStoredLigatures(): boolean | undefined {
  if (typeof localStorage === "undefined") return undefined;
  const raw = localStorage.getItem(STORAGE_KEY_LIGATURES);
  if (raw === null) return undefined;
  return raw === "true" ? true : raw === "false" ? false : undefined;
}

function readStoredLineHeight(): EditorFontLineHeight | undefined {
  if (typeof localStorage === "undefined") return undefined;
  const raw = localStorage.getItem(STORAGE_KEY_LINE_HEIGHT);
  if (raw === null) return undefined;
  const n = Number(raw);
  const valid: EditorFontLineHeight[] = [1.0, 1.2, 1.4];
  return (valid as number[]).includes(n) ? (n as EditorFontLineHeight) : undefined;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useEditorFontStore = create<EditorFontState>((set) => {
  const initialSize = readStoredSize();
  const initialFamily = readStoredFamily();
  const initialLigatures = readStoredLigatures();
  const initialLineHeight = readStoredLineHeight();

  return {
    size: initialSize,
    family: initialFamily,
    ligatures: initialLigatures,
    lineHeight: initialLineHeight,

    hydrate({ size, family, ligatures, lineHeight }) {
      set({ size, family, ligatures, lineHeight });
      // Keep localStorage in sync with appState authoritative values.
      if (typeof localStorage !== "undefined") {
        if (size !== undefined) localStorage.setItem(STORAGE_KEY_SIZE, String(size));
        else localStorage.removeItem(STORAGE_KEY_SIZE);

        if (family !== undefined) localStorage.setItem(STORAGE_KEY_FAMILY, family);
        else localStorage.removeItem(STORAGE_KEY_FAMILY);

        if (ligatures !== undefined) localStorage.setItem(STORAGE_KEY_LIGATURES, String(ligatures));
        else localStorage.removeItem(STORAGE_KEY_LIGATURES);

        if (lineHeight !== undefined)
          localStorage.setItem(STORAGE_KEY_LINE_HEIGHT, String(lineHeight));
        else localStorage.removeItem(STORAGE_KEY_LINE_HEIGHT);
      }
    },

    setSize(size) {
      set({ size });
      if (typeof localStorage !== "undefined") {
        if (size !== undefined) localStorage.setItem(STORAGE_KEY_SIZE, String(size));
        else localStorage.removeItem(STORAGE_KEY_SIZE);
      }
      void ipcCallResult("appState", "set", { editorFontSize: size }).then((r) => {
        if (!r.ok) log.warn(`appState set failed (size): ${r.message}`);
      });
      dispatchFontChanged();
    },

    setFamily(family) {
      set({ family });
      if (typeof localStorage !== "undefined") {
        if (family !== undefined) localStorage.setItem(STORAGE_KEY_FAMILY, family);
        else localStorage.removeItem(STORAGE_KEY_FAMILY);
      }
      void ipcCallResult("appState", "set", { editorFontFamily: family }).then((r) => {
        if (!r.ok) log.warn(`appState set failed (family): ${r.message}`);
      });
      dispatchFontChanged();
    },

    setLigatures(ligatures) {
      set({ ligatures });
      if (typeof localStorage !== "undefined") {
        if (ligatures !== undefined) localStorage.setItem(STORAGE_KEY_LIGATURES, String(ligatures));
        else localStorage.removeItem(STORAGE_KEY_LIGATURES);
      }
      void ipcCallResult("appState", "set", { editorFontLigatures: ligatures }).then((r) => {
        if (!r.ok) log.warn(`appState set failed (ligatures): ${r.message}`);
      });
      dispatchFontChanged();
    },

    setLineHeight(lineHeight) {
      set({ lineHeight });
      if (typeof localStorage !== "undefined") {
        if (lineHeight !== undefined)
          localStorage.setItem(STORAGE_KEY_LINE_HEIGHT, String(lineHeight));
        else localStorage.removeItem(STORAGE_KEY_LINE_HEIGHT);
      }
      void ipcCallResult("appState", "set", { editorFontLineHeight: lineHeight }).then((r) => {
        if (!r.ok) log.warn(`appState set failed (lineHeight): ${r.message}`);
      });
      dispatchFontChanged();
    },
  };
});
