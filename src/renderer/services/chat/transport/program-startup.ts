import { ipcCallResult, unwrapIpcResult } from "../../../ipc/client";

/** Stops the current program and waits for the agent to confirm the stop. */
export async function stopChatProgram(workspaceId: string, tabId: string): Promise<void> {
  unwrapIpcResult(await ipcCallResult("chat", "stop", { workspaceId, tabId }));
}

/** Owns a tab's active startup and cleanup of a program that failed initialization. */
export class ProgramStartup {
  pending: Promise<boolean> | null = null;
  failed = false;
  private needsStop = false;

  constructor(private readonly stop: () => Promise<void>) {}

  /** Shares a startup between concurrent callers of the same program. */
  run(start: () => Promise<boolean>): Promise<boolean> {
    this.pending ??= Promise.resolve()
      .then(start)
      .finally(() => {
        this.pending = null;
      });
    return this.pending;
  }

  /** Refuses to start again until the failed program has stopped. */
  async prepare(): Promise<void> {
    if (!this.needsStop) return;
    await this.stop();
    this.needsStop = false;
  }

  /** Records a failed startup and tries to stop the program now. */
  async reject(): Promise<void> {
    this.failed = true;
    this.needsStop = true;
    await this.prepare();
  }
}
