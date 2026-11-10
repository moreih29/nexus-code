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
