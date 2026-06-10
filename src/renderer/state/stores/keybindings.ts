// src/renderer/state/stores/keybindings.ts — user keybinding override store.
//
// Persistence model (mirrors theme.ts minus the localStorage boot cache —
// keybindings paint nothing before React mounts, so there is no FOUC to
// prevent and appState alone is sufficient):
//   - appState (main process, via IPC) — authoritative store; main also
//     reads it to rebuild native menu accelerator labels.
//   - This zustand store — live copy driving (a) the dispatcher via
//     `setActiveBindings` recompilation, (b) the Settings panel UI.
//
// Every mutation recompiles the resolver SYNCHRONOUSLY before the IPC
// write — a rebinding must take effect on the very next keydown, not
// after a round-trip.

import { create } from "zustand";
import { ALL_COMMAND_IDS } from "../../../shared/keybindings/commands";
import { ALL_EDITOR_COMMAND_IDS } from "../../../shared/keybindings/editor-commands";
import { KEYBINDINGS, type KeybindingDecl } from "../../../shared/keybindings/index";
import {
  applyKeybindingOverrides,
  type KeybindingOverride,
  removeOverride,
  upsertOverride,
} from "../../../shared/keybindings/overrides";
import { createLogger } from "../../../shared/log/renderer";
import { ipcCallResult } from "../../ipc/client";
import { setActiveBindings } from "../../keybindings/resolver";
import { applyEditorKeybindingOverrides } from "../../services/editor/keybindings/apply";

const log = createLogger("keybindings");

const KNOWN_COMMANDS: ReadonlySet<string> = new Set(ALL_COMMAND_IDS);

function effective(overrides: readonly KeybindingOverride[]): KeybindingDecl[] {
  return applyKeybindingOverrides(KEYBINDINGS, overrides, KNOWN_COMMANDS);
}

interface KeybindingsState {
  /** Raw override list (the persisted delta). */
  overrides: KeybindingOverride[];
  /** Defaults + overrides, already merged — what the dispatcher runs on. */
  effectiveBindings: KeybindingDecl[];
  /** Raw editor (Monaco) override list (the persisted delta). */
  editorOverrides: KeybindingOverride[];

  /**
   * Hydrate from persisted appState — called during bootstrap and on
   * `keybindingsChanged` broadcasts from other windows. Recompiles the
   * dispatcher; does NOT write back to appState (no feedback loops).
   */
  hydrate(overrides: readonly KeybindingOverride[] | undefined): void;

  /**
   * Upsert one command's override (recorded binding or explicit
   * unbind). Recompiles + persists.
   */
  setOverride(patch: KeybindingOverride): void;

  /** Drop one command's override (restore its defaults). Recompiles + persists. */
  resetCommand(command: string): void;

  /** Drop every override. Recompiles + persists. */
  resetAll(): void;

  /**
   * Hydrate editor overrides from appState (bootstrap +
   * `editorKeybindingsChanged` broadcasts). Reconciles Monaco if it is
   * ready; otherwise the binding is applied later by
   * `applyEditorBindings()` once editor services initialize. No
   * write-back.
   */
  hydrateEditor(overrides: readonly KeybindingOverride[] | undefined): void;

  /**
   * Re-reconcile Monaco from the current editor overrides. Called from
   * `initializeEditorServices` after the Monaco singleton is ready,
   * since bootstrap hydration usually runs before Monaco mounts.
   */
  applyEditorBindings(): void;

  /** Upsert one editor command's override. Reconciles Monaco + persists. */
  setEditorOverride(patch: KeybindingOverride): void;

  /** Drop one editor command's override (restore its default). Reconciles + persists. */
  resetEditorCommand(command: string): void;

  /** Drop every editor override. Reconciles + persists. */
  resetAllEditor(): void;
}

function persist(overrides: KeybindingOverride[]): void {
  // Fire-and-forget: the in-memory recompile already happened; appState
  // is the durable store. Main reacts by rebuilding the native menu and
  // broadcasting `keybindingsChanged` to the other windows.
  void ipcCallResult("appState", "set", { keybindingOverrides: overrides }).then((result) => {
    if (!result.ok) log.warn(`appState set failed: ${result.message}`);
  });
}

function persistEditor(overrides: KeybindingOverride[]): void {
  // Fire-and-forget: Monaco was already reconciled in-memory. Main
  // broadcasts `editorKeybindingsChanged` so other windows reconcile too.
  void ipcCallResult("appState", "set", { editorKeybindingOverrides: overrides }).then((result) => {
    if (!result.ok) log.warn(`appState set (editor) failed: ${result.message}`);
  });
}

const KNOWN_EDITOR_COMMANDS: ReadonlySet<string> = ALL_EDITOR_COMMAND_IDS;

/** Keep only overrides whose command is in the curated editor catalog. */
function knownEditorOverrides(
  overrides: readonly KeybindingOverride[] | undefined,
): KeybindingOverride[] {
  if (overrides === undefined) return [];
  return overrides.filter((o) => KNOWN_EDITOR_COMMANDS.has(o.command));
}

export const useKeybindingsStore = create<KeybindingsState>((set, get) => ({
  overrides: [],
  effectiveBindings: [...KEYBINDINGS],
  editorOverrides: [],

  hydrate(overrides) {
    const next = overrides !== undefined ? [...overrides] : [];
    const merged = effective(next);
    setActiveBindings(merged);
    set({ overrides: next, effectiveBindings: merged });
  },

  setOverride(patch) {
    const next = upsertOverride(get().overrides, patch);
    const merged = effective(next);
    setActiveBindings(merged);
    set({ overrides: next, effectiveBindings: merged });
    persist(next);
  },

  resetCommand(command) {
    const next = removeOverride(get().overrides, command);
    const merged = effective(next);
    setActiveBindings(merged);
    set({ overrides: next, effectiveBindings: merged });
    persist(next);
  },

  resetAll() {
    const merged = effective([]);
    setActiveBindings(merged);
    set({ overrides: [], effectiveBindings: merged });
    persist([]);
  },

  hydrateEditor(overrides) {
    const next = knownEditorOverrides(overrides);
    set({ editorOverrides: next });
    // No-op until Monaco is ready; applyEditorBindings() re-runs later.
    applyEditorKeybindingOverrides(next);
  },

  applyEditorBindings() {
    applyEditorKeybindingOverrides(get().editorOverrides);
  },

  setEditorOverride(patch) {
    const next = upsertOverride(get().editorOverrides, patch);
    applyEditorKeybindingOverrides(next);
    set({ editorOverrides: next });
    persistEditor(next);
  },

  resetEditorCommand(command) {
    const next = removeOverride(get().editorOverrides, command);
    applyEditorKeybindingOverrides(next);
    set({ editorOverrides: next });
    persistEditor(next);
  },

  resetAllEditor() {
    applyEditorKeybindingOverrides([]);
    set({ editorOverrides: [] });
    persistEditor([]);
  },
}));
