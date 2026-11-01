/**
 * Every live terminal's output activity, which tells what Codex and other
 * agents are doing, as main last reported it. Read every few seconds for the
 * tab bar, the sidebar and the inbox; the sessions tab reads it faster on its
 * own while it is shown.
 */

import { create } from "zustand";
import type { TabActivity } from "../../../shared/sessions/agent-state";

interface TabActivityStore {
  /** Keyed by `${workspaceId}:${tabId}`. */
  activity: ReadonlyMap<string, TabActivity>;
  /** When it was last read; whether a terminal is busy is told against it. */
  readAt: number;
}

export const useTabActivityStore = create<TabActivityStore>(() => ({
  activity: new Map(),
  readAt: Date.now(),
}));
