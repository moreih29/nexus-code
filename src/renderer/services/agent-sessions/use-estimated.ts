/**
 * The glyphs the tab bar and the sidebar show for Codex and other agents,
 * whose state is told from their output rather than reported by hooks, for
 * the terminals Claude reports nothing for.
 */

import { useSyncExternalStore } from "react";
import { useShallow } from "zustand/shallow";
import { useClaudeStatusStore } from "../../state/stores/claude-status";
import { useSessionSeenStore } from "../../state/stores/session-seen";
import {
  subscribeTabActivity,
  tabActivityReadAt,
  useTabActivityStore,
} from "../../state/stores/tab-activity";
import { type Tab, useTabsStore } from "../../state/stores/tabs";
import { type EstimatedGlyph, estimatedGlyph, sessionKey, workspaceEstimatedGlyph } from "./model";
import { useViewingKey } from "./viewing";

/** A terminal tab's estimated glyph, or none while `enabled` is false. */
export function useEstimatedTabGlyph(
  workspaceId: string,
  tab: Tab,
  enabled: boolean,
): EstimatedGlyph | null {
  const key = sessionKey(workspaceId, tab.id);
  const viewing = useViewingKey() === key;
  const seenAt = useSessionSeenStore((s) => s.byWorkspace[workspaceId]?.[tab.id]);
  return useSyncExternalStore(subscribeTabActivity, () =>
    enabled
      ? estimatedGlyph(
          tab,
          useTabActivityStore.getState().activity.get(key),
          seenAt,
          tabActivityReadAt(),
          viewing,
        )
      : null,
  );
}

function recordOf<T>(
  ids: readonly string[],
  values: readonly (T | undefined)[],
): Record<string, T> {
  const record: Record<string, T> = {};
  ids.forEach((id, i) => {
    const value = values[i];
    if (value !== undefined) record[id] = value;
  });
  return record;
}

/** The strongest estimated glyph of the terminals of `workspaceIds`. */
export function useEstimatedWorkspaceGlyph(workspaceIds: readonly string[]): EstimatedGlyph | null {
  const viewing = useViewingKey();
  const tabs = useTabsStore(useShallow((s) => workspaceIds.map((id) => s.byWorkspace[id])));
  const claude = useClaudeStatusStore(
    useShallow((s) => workspaceIds.map((id) => s.byWorkspace[id])),
  );
  const seen = useSessionSeenStore(useShallow((s) => workspaceIds.map((id) => s.byWorkspace[id])));
  return useSyncExternalStore(subscribeTabActivity, () =>
    workspaceEstimatedGlyph(
      {
        tabsByWorkspace: recordOf(workspaceIds, tabs),
        claudeByWorkspace: recordOf(workspaceIds, claude),
        seenByWorkspace: recordOf(workspaceIds, seen),
        activity: useTabActivityStore.getState().activity,
        now: tabActivityReadAt(),
      },
      workspaceIds,
      viewing,
    ),
  );
}
