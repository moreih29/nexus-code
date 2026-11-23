import { useShallow } from "zustand/shallow";
import type { ClaudeStatus } from "../../../shared/claude/status";
import { useSessionSeenStore } from "../../state/stores/session-seen";
import { type Tab, useTabsStore } from "../../state/stores/tabs";
import { chatKey, useChatStore } from "../chat/store";
import { claudeChatStateOf, codexStateOf, workspaceCodexState } from "./codex-state";
import { useViewingKey } from "./viewing";

export function useChatTabStatus(workspaceId: string, tab: Tab): ClaudeStatus | undefined {
  const key = chatKey(workspaceId, tab.id);
  const viewing = useViewingKey() === key;
  const seenAt = useSessionSeenStore((s) => s.byWorkspace[workspaceId]?.[tab.id]);
  return useChatStore((s) => {
    if (tab.type === "claude") return claudeChatStateOf(s.tabs[key], seenAt, viewing)?.state;
    if (tab.type === "codex") return codexStateOf(s.tabs[key], seenAt, viewing).state;
    return undefined;
  });
}

export function useCodexWorkspaceStatus(workspaceIds: readonly string[]): ClaudeStatus | null {
  const viewing = useViewingKey();
  const tabs = useTabsStore(useShallow((s) => workspaceIds.map((id) => s.byWorkspace[id])));
  const seen = useSessionSeenStore(useShallow((s) => workspaceIds.map((id) => s.byWorkspace[id])));
  return useChatStore((s) =>
    workspaceCodexState(
      workspaceIds,
      Object.fromEntries(workspaceIds.map((id, i) => [id, tabs[i]])),
      Object.fromEntries(workspaceIds.map((id, i) => [id, seen[i]])),
      s.tabs,
      viewing,
    ),
  );
}
