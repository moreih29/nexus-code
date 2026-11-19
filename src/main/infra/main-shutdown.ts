import { defaultTimerScheduler, type TimerScheduler } from "../../shared/util/timer-scheduler";

export const MAIN_QUIT_GRACE_MS = 3_000;
// Match the Go LSP request, exit and forced-exit grace periods.
const LSP_QUIT_GRACE_MS = 2_250;

interface ShutdownWork {
  readonly waitForNotes: () => Promise<void> | undefined;
  readonly disposeGitHelpers: () => Promise<void> | undefined;
  readonly lspShutdown?: Promise<void>;
  readonly closeWorkspaces: () => void;
  readonly waitForLocalAgents: () => Promise<void>;
  readonly warn: (message: string) => void;
}

/** Drains writes and children in parallel, with a shared deadline for the whole quit. */
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

  /** Closes agents once, including when the total deadline beats LSP. */
  function closeWorkspaces(): void {
    if (workspacesClosed) return;
    workspacesClosed = true;
    work.closeWorkspaces();
  }

  /** Gives LSP its own grace while keeping the transports it needs alive. */
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
