import type { DropZone } from "../../types/workbench-dnd";

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

export const ZONE_DIRECTION = {
  top: "up",
  bottom: "down",
  left: "left",
  right: "right",
} as const satisfies Record<Exclude<DropZone, "center">, string>;

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

export function insertionIndex(
  tabIds: readonly string[],
  key: string,
  before: string | null,
): number {
  if (before === key) return Math.max(0, tabIds.indexOf(key));
  const without = tabIds.filter((id) => id !== key);
  const at = before === null ? -1 : without.indexOf(before);
  return at >= 0 ? at : without.length;
}
