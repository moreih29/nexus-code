import { useShallow } from "zustand/react/shallow";
import type { TerminalOpener } from "../../../shared/chat/relay";
import { useTabsStore } from "../../state/stores/tabs";

/** The stored workspace is a hint: the parent tab may have moved. */
export function useSessionParent(opener: TerminalOpener | undefined) {
  const tabId = opener?.tabId;
  const open = useTabsStore(
    useShallow(({ byWorkspace }) => {
      if (!tabId || opener?.device) return undefined;
      const hint = opener?.workspaceId;
      if (hint && byWorkspace[hint]?.[tabId]) {
        return { workspaceId: hint, tabId, title: byWorkspace[hint][tabId].title };
      }
      for (const workspaceId in byWorkspace) {
        const tab = byWorkspace[workspaceId]?.[tabId];
        if (tab) return { workspaceId, tabId, title: tab.title };
      }
      return undefined;
    }),
  );
  return {
    open,
    name: open?.title || opener?.name || tabId?.slice(0, 8) || opener?.agent,
  };
}
