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
import { applyAppChordsToMonaco } from "../../services/editor/keybindings/app-chords";
import { applyEditorKeybindingOverrides } from "../../services/editor/keybindings/apply";

const log = createLogger("keybindings");

const KNOWN_COMMANDS: ReadonlySet<string> = new Set(ALL_COMMAND_IDS);

function effective(overrides: readonly KeybindingOverride[]): KeybindingDecl[] {
  return applyKeybindingOverrides(KEYBINDINGS, overrides, KNOWN_COMMANDS);
}

function activate(bindings: readonly KeybindingDecl[]): void {
  setActiveBindings(bindings);
  applyAppChordsToMonaco(bindings);
}

interface KeybindingsState {
  overrides: KeybindingOverride[];
  effectiveBindings: KeybindingDecl[];
  editorOverrides: KeybindingOverride[];

  hydrate(overrides: readonly KeybindingOverride[] | undefined): void;

  setOverride(patch: KeybindingOverride): void;

  resetCommand(command: string): void;

  resetAll(): void;

  hydrateEditor(overrides: readonly KeybindingOverride[] | undefined): void;

  applyEditorBindings(): void;

  setEditorOverride(patch: KeybindingOverride): void;

  resetEditorCommand(command: string): void;

  resetAllEditor(): void;
}

function persist(overrides: KeybindingOverride[]): void {
  void ipcCallResult("appState", "set", { keybindingOverrides: overrides }).then((result) => {
    if (!result.ok) log.warn(`appState set failed: ${result.message}`);
  });
}

function persistEditor(overrides: KeybindingOverride[]): void {
  void ipcCallResult("appState", "set", { editorKeybindingOverrides: overrides }).then((result) => {
    if (!result.ok) log.warn(`appState set (editor) failed: ${result.message}`);
  });
}

const KNOWN_EDITOR_COMMANDS: ReadonlySet<string> = ALL_EDITOR_COMMAND_IDS;

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
    activate(merged);
    set({ overrides: next, effectiveBindings: merged });
  },

  setOverride(patch) {
    const next = upsertOverride(get().overrides, patch);
    const merged = effective(next);
    activate(merged);
    set({ overrides: next, effectiveBindings: merged });
    persist(next);
  },

  resetCommand(command) {
    const next = removeOverride(get().overrides, command);
    const merged = effective(next);
    activate(merged);
    set({ overrides: next, effectiveBindings: merged });
    persist(next);
  },

  resetAll() {
    const merged = effective([]);
    activate(merged);
    set({ overrides: [], effectiveBindings: merged });
    persist([]);
  },

  hydrateEditor(overrides) {
    const next = knownEditorOverrides(overrides);
    set({ editorOverrides: next });
    applyEditorKeybindingOverrides(next);
  },

  applyEditorBindings() {
    applyEditorKeybindingOverrides(get().editorOverrides);
    applyAppChordsToMonaco(get().effectiveBindings);
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
