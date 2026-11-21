import type { DocNode } from "../../../shared/notes/markdown";
import { defaultTimerScheduler, type TimerScheduler } from "../../../shared/util/timer-scheduler";

const SAVE_DELAY_MS = 500;

type NoteChange = { title?: string; doc?: DocNode };
export type NoteSaveState = "saved" | "saving" | "error";

export function createNoteAutoSave(
  save: (change: NoteChange) => Promise<unknown>,
  setState: (state: NoteSaveState) => void,
  scheduler: TimerScheduler = defaultTimerScheduler,
) {
  let pending: NoteChange = {};
  let timer: unknown;
  let writing: Promise<boolean> | undefined;
  let discardCount = 0;

  function clearTimer(): void {
    if (timer === undefined) return;
    scheduler.clearTimeout(timer);
    timer = undefined;
  }

  async function savePending(): Promise<boolean> {
    setState("saving");
    while (hasPending()) {
      const change = pending;
      const revision = discardCount;
      pending = {};
      try {
        await save(change);
      } catch {
        if (revision === discardCount) pending = { ...change, ...pending };
        setState("error");
        return false;
      }
      clearTimer();
    }
    setState("saved");
    return true;
  }

  function hasPending(): boolean {
    return pending.title !== undefined || pending.doc !== undefined;
  }

  function flush(): Promise<boolean> {
    clearTimer();
    if (writing) return writing.then((saved) => saved && flush());
    if (!hasPending()) return Promise.resolve(true);
    writing = savePending().finally(() => {
      writing = undefined;
    });
    return writing;
  }

  return {
    schedule(change: NoteChange): void {
      pending = { ...pending, ...change };
      clearTimer();
      timer = scheduler.setTimeout(() => void flush(), SAVE_DELAY_MS);
    },
    flush,
    discard(): void {
      discardCount++;
      pending = {};
      clearTimer();
    },
  };
}

const noteSaves = new Set<{ flush: () => Promise<boolean> }>();

export function registerNoteSave(flush: () => Promise<boolean>): () => void {
  const entry = { flush };
  noteSaves.add(entry);
  return () => {
    noteSaves.delete(entry);
  };
}

export async function flushPendingNoteSaves(): Promise<boolean> {
  const results = await Promise.allSettled(Array.from(noteSaves, async ({ flush }) => flush()));
  return results.every((result) => result.status === "fulfilled" && result.value);
}
