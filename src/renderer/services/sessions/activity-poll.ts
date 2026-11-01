/**
 * Keeps the terminals' output activity current for the tab bar, the sidebar
 * and the inbox. Claude's state is pushed; Codex and other agents' only shows
 * in their output, which can wait a moment.
 */

import { createLogger } from "../../../shared/log/renderer";
import { ipcCallResult } from "../../ipc/client";
import { useTabActivityStore } from "../../state/stores/tab-activity";
import { activityByKey, sameActivity } from "./model";

const log = createLogger("tab-activity");

const ACTIVITY_POLL_MS = 2_000;

/** Reads the activity once; a read that tells the same keeps the map it had. */
export async function readTabActivity(): Promise<void> {
  const result = await ipcCallResult("cli", "activity", {});
  const readAt = Date.now();
  if (!result.ok) {
    log.warn(`activity read failed: ${result.message}`);
    // The clock still moves on, so a terminal stops reading as busy.
    useTabActivityStore.setState({ readAt });
    return;
  }
  const next = activityByKey(result.value);
  const prev = useTabActivityStore.getState().activity;
  useTabActivityStore.setState({ activity: sameActivity(prev, next) ? prev : next, readAt });
}

/** Reads the activity every `everyMs`, one read at a time. Returns the stop. */
export function startTabActivityPolling(everyMs = ACTIVITY_POLL_MS): () => void {
  let reading = false;
  const poll = async (): Promise<void> => {
    if (reading) return;
    reading = true;
    try {
      await readTabActivity();
    } catch (failure) {
      log.warn(`activity read failed: ${(failure as Error).message}`);
    } finally {
      reading = false;
    }
  };
  void poll();
  const timer = setInterval(() => void poll(), everyMs);
  return () => clearInterval(timer);
}
