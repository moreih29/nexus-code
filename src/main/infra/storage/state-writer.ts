import { setImmediate } from "node:timers/promises";
import { Worker } from "node:worker_threads";
import type { AppState } from "../../../shared/types/app-state";
import { CANCELLED, PREPARING } from "./state-file";
import type { Layouts, StateWriteMessage, StateWriteResult } from "./state-writer.worker";

const WORKER_WRITE_TIMEOUT_MS = 5_000;

export class StateWorkerError extends Error {
  constructor(
    message: string,
    readonly startup: boolean,
  ) {
    super(message);
  }
}

export class StateWriter {
  private worker?: { thread: Worker; ready: boolean };

  constructor(
    private readonly filePath: string,
    private readonly workerPath: string,
  ) {}

  /** One call at a time. Partition the clone of a large layout across main turns. */
  async write(snapshot: AppState, gate: Int32Array): Promise<boolean> {
    this.worker ??= this.startWorker();
    const current = this.worker;
    const worker = current.thread;
    const layoutByWorkspace = snapshot.layoutByWorkspace;
    const state = { ...snapshot, layoutByWorkspace: undefined };
    const send = (message: StateWriteMessage) => worker.postMessage(message);
    worker.ref();
    return new Promise<boolean>((resolve, reject) => {
      let failure: StateWorkerError | undefined;
      const onError = (error: Error) => {
        failure ??= new StateWorkerError(String(error), !current.ready);
      };
      const onExit = (code: number) => {
        failure ??= new StateWorkerError(`App state writer exited (${code})`, !current.ready);
        cleanUp();
        reject(failure);
      };
      const onMessage = (result: StateWriteResult) => {
        if ("ready" in result) {
          current.ready = true;
          return;
        }
        if (failure) return;
        cleanUp();
        if ("error" in result) reject(new Error(result.error));
        else resolve(result.written);
      };
      const cleanUp = () => {
        clearTimeout(watchdog);
        worker.off("error", onError);
        worker.off("exit", onExit);
        worker.off("message", onMessage);
        worker.unref();
      };
      const watchdog = setTimeout(() => {
        failure ??= new StateWorkerError("App state worker write timed out", !current.ready);
        Atomics.compareExchange(gate, 0, PREPARING, CANCELLED);
        // An old rename can only be ruled out after the worker has exited.
        void worker.terminate().catch(onError);
      }, WORKER_WRITE_TIMEOUT_MS);
      worker.on("error", onError);
      worker.once("exit", onExit);
      worker.on("message", onMessage);
      void this.sendLayouts(layoutByWorkspace, gate, send)
        .then(() => send({ kind: "write", state, hasLayouts: !!layoutByWorkspace, gate }))
        .catch((error: unknown) => {
          if (failure) return;
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

  private startWorker(): NonNullable<StateWriter["worker"]> {
    let worker: Worker;
    try {
      worker = new Worker(this.workerPath, { workerData: this.filePath });
    } catch (error) {
      throw new StateWorkerError(`Could not start app state worker: ${String(error)}`, true);
    }
    // An idle worker can exit too. Keep an error listener until exit.
    worker.on("error", () => {});
    worker.once("exit", () => {
      this.worker = undefined;
    });
    return { thread: worker, ready: false };
  }
}
