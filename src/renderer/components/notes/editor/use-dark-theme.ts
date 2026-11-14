/** Whether the app's theme is dark, following it as the user changes it. */
import { THEME_SOURCE_BY_ID } from "../../../../shared/design-tokens/theme-sources";
import { useThemeStore } from "../../../state/stores/theme";

export function useDarkTheme(): boolean {
  const theme = useThemeStore((s) => s.resolved);
  return THEME_SOURCE_BY_ID[theme]?.base === "dark";
}
