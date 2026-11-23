import { COMMANDS, type CommandId } from "../../shared/keybindings/commands";
import { findDisplayPrimary } from "../../shared/keybindings/index";
import { acceleratorToLabel, chordToLabel } from "../../shared/keybindings/keybinding-parse";
import { type HostPlatform, hostPlatform, isLinux, isMac } from "../utils/platform";
import { getActiveBindings } from "./resolver";

export function labelOptions(): { isMac: boolean; platform: HostPlatform } {
  return { isMac: isMac(), platform: hostPlatform() };
}

export function shortcutFor(command: CommandId): string | undefined {
  const bindings = getActiveBindings();
  const primary = findDisplayPrimary(bindings, command, isMac(), isLinux());
  if (primary?.primary !== undefined) {
    return acceleratorToLabel(primary.primary, labelOptions());
  }
  const chord = bindings.find((b) => b.command === command && b.chord !== undefined);
  if (chord?.chord !== undefined) {
    return chordToLabel(chord.chord, labelOptions());
  }
  return undefined;
}

export const SHORTCUTS = {
  get closeTab() {
    return shortcutFor(COMMANDS.tabClose) ?? "";
  },
  get closeOthers() {
    return shortcutFor(COMMANDS.tabCloseOthers) ?? "";
  },
  get closeSaved() {
    return shortcutFor(COMMANDS.tabCloseSaved) ?? "";
  },
  get closeAll() {
    return shortcutFor(COMMANDS.tabCloseAll) ?? "";
  },
  get pinTab() {
    return shortcutFor(COMMANDS.tabPinToggle) ?? "";
  },
  get splitRight() {
    return shortcutFor(COMMANDS.groupSplitRight) ?? "";
  },
  get splitDown() {
    return shortcutFor(COMMANDS.groupSplitDown) ?? "";
  },
  get revealInOS() {
    return shortcutFor(COMMANDS.pathReveal) ?? "";
  },
  get copyPath() {
    return shortcutFor(COMMANDS.pathCopy) ?? "";
  },
  get copyRelativePath() {
    return shortcutFor(COMMANDS.pathCopyRelative) ?? "";
  },
  get openToSide() {
    return shortcutFor(COMMANDS.openToSide) ?? "";
  },
  get fileRename() {
    return shortcutFor(COMMANDS.fileRename) ?? "";
  },
  get fileDelete() {
    return shortcutFor(COMMANDS.fileDelete) ?? "";
  },
  get fileCopy() {
    return shortcutFor(COMMANDS.fileCopy) ?? "";
  },
  get fileCut() {
    return shortcutFor(COMMANDS.fileCut) ?? "";
  },
  get filePaste() {
    return shortcutFor(COMMANDS.filePaste) ?? "";
  },
};
