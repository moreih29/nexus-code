import { parentOf } from "../../state/stores/files";
import type { FlatItem } from "../../state/stores/files";

/**
 * Returns the flat-list index of the parent dir for the given item, or null if
 * the item is already at the root (no jump should occur).
 *
 * Exported for unit testing — the function is pure and has no React dependencies.
 */
export function computeParentJumpIndex(
  flat: FlatItem[],
  currentItem: FlatItem,
  rootAbsPath: string,
): number | null {
  const parentAbs = parentOf(currentItem.absPath, rootAbsPath);
  if (parentAbs === currentItem.absPath) return null; // already root
  const idx = flat.findIndex((i) => i.absPath === parentAbs);
  if (idx < 0) return null;
  return idx;
}
