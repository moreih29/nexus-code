export const PANEL_BESIDE_PX = 900;
export const SUMMARY_BELOW_PX = 520;

const PANEL_PREF_KEY = "nexus.claude-tab.panel";

export type PanelPlace = "beside" | "drawer" | "summary";

export function placeFor(width: number): PanelPlace {
  if (width >= PANEL_BESIDE_PX) return "beside";
  if (width >= SUMMARY_BELOW_PX) return "drawer";
  return "summary";
}

export function readPanelPref(): boolean {
  try {
    return localStorage.getItem(PANEL_PREF_KEY) !== "closed";
  } catch {
    return true;
  }
}

export function writePanelPref(open: boolean): void {
  try {
    localStorage.setItem(PANEL_PREF_KEY, open ? "open" : "closed");
  } catch {}
}
