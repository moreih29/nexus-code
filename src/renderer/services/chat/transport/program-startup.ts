import { ipcCallResult, unwrapIpcResult } from "../../../ipc/client";

export async function stopChatProgram(workspaceId: string, tabId: string): Promise<void> {
  unwrapIpcResult(await ipcCallResult("chat", "stop", { workspaceId, tabId }));
}

export class ProgramStartup {
  pending: Promise<boolean> | null = null;
  failed = false;
  private needsStop = false;

  constructor(private readonly stop: () => Promise<void>) {}

  run(start: () => Promise<boolean>): Promise<boolean> {
    this.pending ??= Promise.resolve()
      .then(start)
      .finally(() => {
        this.pending = null;
      });
    return this.pending;
  }

  async prepare(): Promise<void> {
    if (!this.needsStop) return;
    await this.stop();
    this.needsStop = false;
  }

  async reject(): Promise<void> {
    this.failed = true;
    this.needsStop = true;
    await this.prepare();
  }
}
