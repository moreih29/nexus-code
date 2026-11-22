import { expect, test } from "bun:test";
import {
  publishTabActivity,
  subscribeTabActivity,
  tabActivityReadAt,
  useTabActivityStore,
} from "../../../../../src/renderer/state/stores/tab-activity";
import { BUSY_WINDOW_MS } from "../../../../../src/shared/sessions/agent-state";

test("identical activity reads only notify status consumers when a terminal goes quiet", () => {
  const previous = useTabActivityStore.getState().activity;
  const previousReadAt = tabActivityReadAt();
  const lastOutputAt = Date.now();
  const busyUntil = lastOutputAt + BUSY_WINDOW_MS;
  const activity = new Map([["workspace:terminal", { lastOutputAt }]]);
  let mapChanges = 0;
  const statusReadTimes: number[] = [];
  const stopMap = useTabActivityStore.subscribe(() => {
    mapChanges += 1;
  });
  const stopStatus = subscribeTabActivity(() => statusReadTimes.push(tabActivityReadAt()));

  try {
    publishTabActivity(activity, lastOutputAt);
    publishTabActivity(activity, busyUntil - 1);
    publishTabActivity(activity, busyUntil);
    publishTabActivity(activity, busyUntil + 1);
    expect(useTabActivityStore.getState().activity).toBe(activity);
    expect(mapChanges).toBe(1);
    expect(statusReadTimes).toEqual([lastOutputAt, busyUntil]);
  } finally {
    stopMap();
    stopStatus();
    publishTabActivity(previous, previousReadAt);
  }
});
