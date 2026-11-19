import { expect, mock, test } from "bun:test";
import { ClosePersistence } from "../../../../../src/main/features/window/close-persistence";
import type { TimerScheduler } from "../../../../../src/shared/util/timer-scheduler";

/** Drives main's bounded waits without advancing real time. */
function fakeTimer(): TimerScheduler & { expire(): void } {
  const timers = new Set<() => void>();
  return {
    setTimeout(callback) {
      timers.add(callback);
      return callback;
    },
    clearTimeout(handle) {
      timers.delete(handle as () => void);
    },
    expire() {
      const pending = [...timers];
      timers.clear();
      for (const callback of pending) callback();
    },
  };
}

/** A window with a separate renderer and native close entry point. */
function fakeWindow(id: number, onClose: () => void = () => {}) {
  const attempts: number[] = [];
  return {
    attempts,
    webContents: {
      id,
      send(_wire: string, _channel: string, _event: string, args: unknown) {
        attempts.push((args as { attempt: number }).attempt);
      },
    },
    isDestroyed: () => false,
    close: mock(onClose),
  };
}

test("quit waits per window, bounds an absent reply, and flushes anew after unload is cancelled", async () => {
  const timer = fakeTimer();
  const warn = mock((_message: string) => {});
  let now = 100;
  const persistence = new ClosePersistence(warn, timer, () => now);
  const first = fakeWindow(1);
  const second = fakeWindow(2);
  const windows = [first, second];
  const event = { preventDefault: mock(() => {}) };
  const replayed = Promise.withResolvers<void>();
  const replay = mock(() => {
    const nativeQuit = { preventDefault: mock(() => {}) };
    persistence.interceptQuit(nativeQuit, windows, replay);
    expect(nativeQuit.preventDefault).not.toHaveBeenCalled();
    persistence.interceptClose(nativeQuit, first);
    expect(nativeQuit.preventDefault).not.toHaveBeenCalled();
    replayed.resolve();
  });

  persistence.interceptQuit(event, windows, replay);
  expect(event.preventDefault).toHaveBeenCalledTimes(1);
  persistence.acknowledge(1, first.attempts[0], true);
  // The first window cannot acknowledge the second one's attempt.
  persistence.acknowledge(1, second.attempts[0], true);
  expect(replay).not.toHaveBeenCalled();
  now += 1_000;
  timer.expire();
  await replayed.promise;
  expect(persistence.remainingQuitMs()).toBe(2_000);
  expect(warn).toHaveBeenCalledTimes(1);

  // The main window's unsaved-buffers dialog returns Cancel.
  persistence.cancelQuit();
  now += 50;
  const retry = Promise.withResolvers<void>();
  persistence.interceptQuit(event, windows, retry.resolve);
  expect(first.attempts).toHaveLength(2);
  expect(second.attempts).toHaveLength(2);
  persistence.acknowledge(1, first.attempts[1], true);
  persistence.acknowledge(2, second.attempts[1], true);
  await retry.promise;
  expect(persistence.remainingQuitMs()).toBe(3_000);
  expect(warn).toHaveBeenCalledTimes(1);
});

test("a failed layout write still resumes one window close through its native guard", async () => {
  const warn = mock((_message: string) => {});
  const persistence = new ClosePersistence(warn, fakeTimer());
  const replayed = Promise.withResolvers<void>();
  const replay = { preventDefault: mock(() => {}) };
  const win = fakeWindow(1, () => {
    persistence.interceptClose(replay, win);
    replayed.resolve();
  });
  const event = { preventDefault: mock(() => {}) };

  persistence.interceptClose(event, win);
  persistence.interceptClose(event, win);
  expect(win.attempts).toHaveLength(1);
  persistence.acknowledge(1, win.attempts[0], false);
  await replayed.promise;
  expect(win.close).toHaveBeenCalledTimes(1);
  expect(replay.preventDefault).not.toHaveBeenCalled();
  expect(warn).toHaveBeenCalledTimes(1);
});
