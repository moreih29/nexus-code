import { Grid } from "@/engine/split";
import { closeTab, openTab, openTabInNewSplit } from "@/state/operations";
import { useLayoutStore } from "@/state/stores/layout";
import { useTabsStore } from "@/state/stores/tabs";
import { killSession } from "./pty-client";
import type { OpenTerminalOptions, TerminalInput, TerminalTabLocation } from "./types";

function groupIdForTab(workspaceId: string, tabId: string): string {
  const layout = useLayoutStore.getState().byWorkspace[workspaceId];
  if (!layout) throw new Error(`layout slice not found for ${workspaceId}`);
  return (
    Grid.findLeafByTab(layout.root, (candidateId) => candidateId === tabId)?.leaf.id ??
    layout.activeGroupId
  );
}

function findTabWorkspace(tabId: string): string | null {
  const byWorkspace = useTabsStore.getState().byWorkspace;
  for (const [workspaceId, tabs] of Object.entries(byWorkspace)) {
    if (tabs[tabId]) return workspaceId;
  }
  return null;
}

export function openTerminal(
  input: TerminalInput,
  opts: OpenTerminalOptions = {},
): TerminalTabLocation {
  useLayoutStore.getState().ensureLayout(input.workspaceId);

  if (opts.newSplit) {
    if (opts.groupId && opts.groupId !== "active") {
      useLayoutStore.getState().setActiveGroup(input.workspaceId, opts.groupId);
    }

    const { orientation, side } = opts.newSplit;
    const { newLeafId, tabId } = openTabInNewSplit(
      input.workspaceId,
      { type: "terminal", props: { cwd: input.cwd } },
      orientation,
      side,
    );
    return { groupId: newLeafId, tabId };
  }

  const tab = openTab(input.workspaceId, "terminal", { cwd: input.cwd }, { groupId: opts.groupId });
  return { groupId: groupIdForTab(input.workspaceId, tab.id), tabId: tab.id };
}

export function closeTerminal(tabId: string): void {
  killSession(tabId);

  const workspaceId = findTabWorkspace(tabId);
  if (!workspaceId) return;
  closeTab(workspaceId, tabId);
}

export function findTerminalTab(
  tabId: string,
): (TerminalTabLocation & { workspaceId: string }) | null {
  const workspaceId = findTabWorkspace(tabId);
  if (!workspaceId) return null;
  return { workspaceId, groupId: groupIdForTab(workspaceId, tabId), tabId };
}
