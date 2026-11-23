import { create } from "zustand";

export type VoiceLanguagePreference = "app" | "multi";

interface VoiceState {
  language: VoiceLanguagePreference;
  sendNames: boolean;
  hydrate(state: { voiceLanguage?: VoiceLanguagePreference; voiceSendNames?: boolean }): void;
  setLanguage(language: VoiceLanguagePreference): void;
  setSendNames(sendNames: boolean): void;
}

export const useVoiceStore = create<VoiceState>((set) => ({
  language: "app",
  sendNames: false,
  hydrate(state) {
    set({ language: state.voiceLanguage ?? "app", sendNames: state.voiceSendNames ?? false });
  },
  setLanguage(language) {
    set({ language });
  },
  setSendNames(sendNames) {
    set({ sendNames });
  },
}));
