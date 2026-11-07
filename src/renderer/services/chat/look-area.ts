/**
 * Where quick look shows: over the panels, beside the sidebar and under the
 * title bar, which stay in sight with what other agents ask. The same area
 * holds the workspaces' groups and the agent view's panels.
 */

/** Marks the area. */
export const LOOK_AREA_ATTR = "data-look-area";

/** The area for a tab whose root is `el`; null while the tab is not in it. */
export function lookAreaOf(el: Pick<Element, "closest"> | null): HTMLElement | null {
  return el?.closest<HTMLElement>(`[${LOOK_AREA_ATTR}]`) ?? null;
}
