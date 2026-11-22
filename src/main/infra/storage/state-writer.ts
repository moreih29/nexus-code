import { setImmediate } from "node:timers/promises";
import { Worker } from "node:worker_threads";
import type { AppState } from "../../../shared/types/app-state";
import { PREPARING } from "./state-file";
import type { Layouts, StateWriteMessage, StateWriteResult } from "./state-writer.worker";

export class StateWriter {
  private worker?: Worker;

  constructor(
    private readonly filePath: string,
    private readonly workerPath: string,
  ) {}

  /** One call at a time. Partition the clone of a large layout across main turns. */
  async write(snapshot: AppState, gate: Int32Array): Promise<boolean> {
    this.worker ??= this.startWorker();
    const worker = this.worker;
    const layoutByWorkspace = snapshot.layoutByWorkspace;
    const state = { ...snapshot, layoutByWorkspace: undefined };
    const send = (message: StateWriteMessage) => worker.postMessage(message);
    worker.ref();
    let failure: Error | undefined;
    return new Promise<boolean>((resolve, reject) => {
      const onError = (error: Error) => {
        failure = error;
      };
      const onExit = (code: number) => {
        cleanUp();
        reject(failure ?? new Error(`App state writer exited (${code})`));
      };
      const onMessage = (result: StateWriteResult) => {
        cleanUp();
        if ("error" in result) reject(new Error(result.error));
        else resolve(result.written);
      };
      const cleanUp = () => {
        worker.off("error", onError);
        worker.off("exit", onExit);
        worker.off("message", onMessage);
        worker.unref();
      };
      worker.on("error", onError);
      worker.once("exit", onExit);
      worker.once("message", onMessage);
      void this.sendLayouts(layoutByWorkspace, gate, send)
        .then(() => send({ kind: "write", state, hasLayouts: !!layoutByWorkspace, gate }))
        .catch((error: unknown) => {
          cleanUp();
          reject(error);
        });
    });
  }

  private async sendLayouts(
    layouts: Layouts | undefined,
    gate: Int32Array,
    send: (message: StateWriteMessage) => void,
  ): Promise<void> {
    send({ kind: "reset" });
    for (const [id, layout] of Object.entries(layouts ?? {})) {
      if (Atomics.load(gate, 0) !== PREPARING) break;
      send({ kind: "layout", id, layout });
      await setImmediate();
    }
  }

  private startWorker(): Worker {
    const worker = new Worker(this.workerPath, { workerData: this.filePath });
    // An idle worker can exit too. Keep an error listener until exit.
    worker.on("error", () => {});
    worker.once("exit", () => {
      this.worker = undefined;
    });
    return worker;
  }
}
