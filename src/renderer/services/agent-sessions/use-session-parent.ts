import { useShallow } from "zustand/react/shallow";
import type { TerminalOpener } from "../../../shared/chat/relay";
import { type Tab, useTabsStore } from "../../state/stores/tabs";
import { sessionParentName } from "./model";

function ownTab(
  byWorkspace: Readonly<Record<string, Record<string, Tab>>>,
  workspaceId: string,
  tabId: string,
): Tab | undefined {
  if (!Object.hasOwn(byWorkspace, workspaceId)) return undefined;
  const tabs = byWorkspace[workspaceId];
  if (!tabs || !Object.hasOwn(tabs, tabId)) return undefined;
  const tab = tabs[tabId];
  return tab?.id === tabId && typeof tab.type === "string" && typeof tab.title === "string"
    ? tab
    : undefined;
}

export function useSessionParent(opener: TerminalOpener | undefined) {
  const tabId = opener?.tabId;
  const open = useTabsStore(
    useShallow(({ byWorkspace }) => {
      if (!tabId || opener?.device) return undefined;
      const hint = opener?.workspaceId;
      const hinted = hint ? ownTab(byWorkspace, hint, tabId) : undefined;
      if (hinted && hint) return { workspaceId: hint, tabId, title: hinted.title };
      for (const workspaceId of Object.keys(byWorkspace)) {
        if (workspaceId === hint) continue;
        const tab = ownTab(byWorkspace, workspaceId, tabId);
        if (tab) return { workspaceId, tabId, title: tab.title };
      }
      return undefined;
    }),
  );
  return {
    open,
    name: sessionParentName(opener, open?.title),
  };
}
