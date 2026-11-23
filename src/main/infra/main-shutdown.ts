import { defaultTimerScheduler, type TimerScheduler } from "../../shared/util/timer-scheduler";

export const MAIN_QUIT_GRACE_MS = 3_000;
const LSP_QUIT_GRACE_MS = 2_250;
const STATE_FLUSH_ATTEMPTS = 3;
const STATE_FLUSH_RETRY_MS = 1_000;

interface QuitStateFlush {
  flush(): void;
  quit(): void;
  warn(message: string): void;
  error(message: string): void;
}

export function createQuitStateFlush(
  work: QuitStateFlush,
  timers: TimerScheduler = defaultTimerScheduler,
): (event: { preventDefault(): void }) => boolean {
  let attempts = 0;
  let retry: unknown;
  return (event) => {
    if (retry !== undefined) {
      timers.clearTimeout(retry);
      retry = undefined;
    }
    try {
      work.flush();
    } catch (error) {
      if (++attempts < STATE_FLUSH_ATTEMPTS) {
        event.preventDefault();
        work.warn(`Could not save app state before quit; retrying: ${String(error)}`);
        retry = timers.setTimeout(work.quit, STATE_FLUSH_RETRY_MS);
        return false;
      }
      work.error(
        `Could not save app state before quit after ${attempts} attempts: ${String(error)}`,
      );
    }
    return true;
  };
}

interface ShutdownWork {
  readonly waitForNotes: () => Promise<void> | undefined;
  readonly disposeGitHelpers: () => Promise<void> | undefined;
  readonly lspShutdown?: Promise<void>;
  readonly closeWorkspaces: () => void;
  readonly waitForLocalAgents: () => Promise<void>;
  readonly warn: (message: string) => void;
}

export async function finishMainShutdown(
  work: ShutdownWork,
  remainingMs: number,
  timers: TimerScheduler = defaultTimerScheduler,
): Promise<void> {
  let deadline: unknown;
  const expired = new Promise<false>((resolve) => {
    deadline = timers.setTimeout(() => resolve(false), remainingMs);
  });
  let lspTimer: unknown;
  let workspacesClosed = false;

  function closeWorkspaces(): void {
    if (workspacesClosed) return;
    workspacesClosed = true;
    work.closeWorkspaces();
  }

  async function stopAgents(): Promise<void> {
    try {
      if (work.lspShutdown) {
        const lspGrace = new Promise<void>((resolve) => {
          lspTimer = timers.setTimeout(resolve, LSP_QUIT_GRACE_MS);
        });
        await Promise.race([work.lspShutdown, lspGrace, expired]);
      }
    } finally {
      closeWorkspaces();
      await work.waitForLocalAgents();
    }
  }

  const tasks = new Map([
    ["note writes", work.waitForNotes],
    ["Git helper socket", work.disposeGitHelpers],
    ["agents", stopAgents],
  ]);
  const completed = Promise.all(
    [...tasks].map(async ([name, finish]) => {
      try {
        await finish();
      } catch (error) {
        work.warn(`Shutdown failed for ${name}: ${String(error)}`);
      } finally {
        tasks.delete(name);
      }
    }),
  ).then(() => true);

  try {
    if (!(await Promise.race([completed, expired]))) {
      work.warn(`App shutdown exceeded ${MAIN_QUIT_GRACE_MS} ms (${[...tasks.keys()].join(", ")})`);
    }
  } finally {
    timers.clearTimeout(deadline);
    if (lspTimer !== undefined) timers.clearTimeout(lspTimer);
    closeWorkspaces();
  }
}
