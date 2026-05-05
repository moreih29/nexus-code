/**
 * Cross-store transaction barrel.
 *
 * Existing import path `@/state/operations` continues to work — every
 * symbol that the previous single-file module exposed is re-exported
 * from here. Internal callers that prefer the narrower modules can
 * import from `@/state/operations/dnd` (or `/tabs`, `/groups`) directly.
 */

export {
  closeTab,
  openEditorTab,
  openTab,
  openTabInNewSplit,
  revealTab,
  splitAndDuplicate,
} from "./tabs";

export { type DropResult, moveTabToZone, openFileAtZone } from "./dnd";

export { closeGroup } from "./groups";
