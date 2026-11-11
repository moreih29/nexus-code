/**
 * Dragging an agent within the agent view: from the list or a panel's tab
 * bar onto a panel, or within the list to put it elsewhere among its
 * workspace's agents. The payload is the agent's session key.
 */

import type { DropZone } from "../workspace/dnd/types";

export const MIME_AGENT = "application/x-nexus-agent";

export function setAgentDrag(dataTransfer: DataTransfer, key: string): void {
  dataTransfer.setData(MIME_AGENT, key);
  dataTransfer.effectAllowed = "move";
}

export function isAgentDrag(dataTransfer: DataTransfer | null): boolean {
  return dataTransfer?.types.includes(MIME_AGENT) ?? false;
}

/** The agent dragged from the list, while it is: a drag over a row cannot read the payload. */
let listDragKey: string | null = null;

export function setListDrag(key: string | null): void {
  listDragKey = key;
}

export function listDrag(): string | null {
  return listDragKey;
}

export function agentDragKey(dataTransfer: DataTransfer | null): string | null {
  const key = dataTransfer?.getData(MIME_AGENT);
  return key ? key : null;
}

/** The side a panel splits toward for an edge it was dropped on. */
export const ZONE_DIRECTION = {
  top: "up",
  bottom: "down",
  left: "left",
  right: "right",
} as const satisfies Record<Exclude<DropZone, "center">, string>;

/**
 * Where a drag over a panel's tab bar puts the agent: before the tab whose
 * middle the pointer is left of (null: after the last), and the x of the
 * line that shows it, in the strip's scrolled content.
 */
export interface TabInsertion {
  x: number;
  before: string | null;
}

export function tabInsertion(strip: HTMLElement, clientX: number): TabInsertion {
  const tabs = Array.from(strip.querySelectorAll<HTMLElement>("[data-agent-tab]"));
  const origin = strip.getBoundingClientRect().left - strip.scrollLeft;
  for (const tab of tabs) {
    const rect = tab.getBoundingClientRect();
    if (clientX < rect.left + rect.width / 2) {
      return { x: rect.left - origin, before: tab.dataset.agentTab ?? null };
    }
  }
  const last = tabs.at(-1);
  return { x: last ? last.getBoundingClientRect().right - origin : 0, before: null };
}

/**
 * The index `key` lands at among `tabIds` when put before `before` (null:
 * after the last), counted without `key`, as moveKey counts.
 */
export function insertionIndex(
  tabIds: readonly string[],
  key: string,
  before: string | null,
): number {
  // Before itself: where it is.
  if (before === key) return Math.max(0, tabIds.indexOf(key));
  const without = tabIds.filter((id) => id !== key);
  const at = before === null ? -1 : without.indexOf(before);
  return at >= 0 ? at : without.length;
}
