import { createLogger } from "../../../shared/log/renderer";
import { ipcCallResult } from "../../ipc/client";
import { publishTabActivity, useTabActivityStore } from "../../state/stores/tab-activity";
import { activityByKey, sameActivity } from "./model";

const log = createLogger("tab-activity");

const ACTIVITY_POLL_MS = 2_000;

export async function readTabActivity(): Promise<void> {
  const result = await ipcCallResult("cli", "activity", {});
  const readAt = Date.now();
  const prev = useTabActivityStore.getState().activity;
  if (!result.ok) {
    log.warn(`activity read failed: ${result.message}`);
    publishTabActivity(prev, readAt);
    return;
  }
  const next = activityByKey(result.value);
  publishTabActivity(sameActivity(prev, next) ? prev : next, readAt);
}

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
