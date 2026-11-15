/**
 * Where a chat's side panel goes, by the chat's width: beside the
 * conversation, over it as a drawer, or, narrower still, behind a one-line
 * summary. A chat here and another computer's place it alike.
 */

/** From this width the side panel sits beside the conversation. */
export const PANEL_BESIDE_PX = 900;
/** Below this width the tab shows a one-line summary in place of the strip. */
export const SUMMARY_BELOW_PX = 520;

/** Whether the side panel is open where it sits beside the conversation. */
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
  } catch {
    // Not kept: the panel opens by default next time.
  }
}
