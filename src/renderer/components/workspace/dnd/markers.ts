/**
 * DOM data-attribute markers used by D&D classification.
 *
 * Both the attribute name and the matching CSS selector are derived from
 * a single constant so a rename grep can never miss one side. Group-level
 * `useDropTarget` reads the bar marker via `closest()` to defer to the
 * tab-bar dropTarget; the tab-bar `useTabBarDropTarget` reads tab-item
 * markers to compute the insertion index.
 */

export const DND_TAB_BAR_ATTR = "data-dnd-tab-bar";
export const DND_TAB_ITEM_ATTR = "data-dnd-tab-item";
/** A surface that takes a file dragged from the file tree itself (a note's body links it). */
export const DND_FILE_SURFACE_ATTR = "data-dnd-file-surface";

export const DND_TAB_BAR_SELECTOR = `[${DND_TAB_BAR_ATTR}]`;
export const DND_TAB_ITEM_SELECTOR = `[${DND_TAB_ITEM_ATTR}]`;
export const DND_FILE_SURFACE_SELECTOR = `[${DND_FILE_SURFACE_ATTR}]`;
