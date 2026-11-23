import { create } from "zustand";
import type { InstructionScope } from "../../../shared/chat/instructions";

interface SettingsUIState {
  settingsOpen: boolean;
  initialActiveId?: string;
  initialInstructionScope?: InstructionScope;
  openInstructions(scope: InstructionScope): void;
  openSettings(): void;
  openSettingsAt(activeId: string): void;
  closeSettings(): void;
  toggleSettings(): void;
}

export const useSettingsUIStore = create<SettingsUIState>((set, get) => ({
  settingsOpen: false,

  openSettings() {
    set({ settingsOpen: true });
  },

  openSettingsAt(activeId) {
    set({ settingsOpen: true, initialActiveId: activeId, initialInstructionScope: undefined });
  },

  openInstructions(scope) {
    set({ settingsOpen: true, initialActiveId: "instructions", initialInstructionScope: scope });
  },

  closeSettings() {
    set({ settingsOpen: false, initialActiveId: undefined, initialInstructionScope: undefined });
  },

  toggleSettings() {
    set({ settingsOpen: !get().settingsOpen });
  },
}));
