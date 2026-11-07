/**
 * Dragging an agent within the agent view: from the list or a panel's tab
 * bar onto a panel. The payload is the agent's session key.
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
