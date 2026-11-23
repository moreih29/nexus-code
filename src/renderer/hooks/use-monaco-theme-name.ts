import { NEXUS_THEME_NAMES } from "../services/editor/runtime/monaco-theme";
import { useThemeStore } from "../state/stores/theme";

export function useMonacoThemeName(): string {
  return useThemeStore((s) => NEXUS_THEME_NAMES[s.resolved]);
}
