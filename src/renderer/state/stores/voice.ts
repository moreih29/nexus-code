// src/renderer/state/stores/voice.ts — voice input's preference.
//
// Mirrors AppState `voiceLanguage`: the language voice input listens for,
// the app's or "multi". Hydrated by bootstrap; the Remote settings page sets
// it and persists it with `appState.set`.

import { create } from "zustand";

export type VoiceLanguagePreference = "app" | "multi";

interface VoiceState {
  language: VoiceLanguagePreference;
  hydrate(state: { voiceLanguage?: VoiceLanguagePreference }): void;
  setLanguage(language: VoiceLanguagePreference): void;
}

export const useVoiceStore = create<VoiceState>((set) => ({
  language: "app",
  hydrate(state) {
    set({ language: state.voiceLanguage ?? "app" });
  },
  setLanguage(language) {
    set({ language });
  },
}));
