/**
 * The state the tab bar, the sidebar and the task switcher show for Codex
 * tabs, read from their conversations as the agent list reads it.
 */

import { useShallow } from "zustand/shallow";
import type { ClaudeStatus } from "../../../shared/claude/status";
import { useSessionSeenStore } from "../../state/stores/session-seen";
import { type Tab, useTabsStore } from "../../state/stores/tabs";
import { chatKey, useChatStore } from "../chat/store";
import { codexStateOf, workspaceCodexState } from "./codex-state";
import { useViewingKey } from "./viewing";

/** A Codex tab's state; null for another kind of tab, or an idle one. */
export function useCodexTabStatus(workspaceId: string, tab: Tab): ClaudeStatus | null {
  const key = chatKey(workspaceId, tab.id);
  const viewing = useViewingKey() === key;
  const seenAt = useSessionSeenStore((s) => s.byWorkspace[workspaceId]?.[tab.id]);
  return useChatStore((s) => {
    if (tab.type !== "codex") return null;
    const { state } = codexStateOf(s.tabs[key], seenAt, viewing);
    return state === "idle" ? null : state;
  });
}

/** The strongest state of the Codex tabs of `workspaceIds`; null when none works or waits. */
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
