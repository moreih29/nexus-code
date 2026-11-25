import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type { Worker } from "node:worker_threads";
import { StateService } from "../../src/main/infra/storage/state-service";

const sourceWorker = fileURLToPath(
  new URL("../../src/main/infra/storage/state-writer.worker.ts", import.meta.url),
);

const WRITE_SETTLE_MS = 4_000;

interface StateServiceInternals {
  timer?: ReturnType<typeof globalThis.setTimeout>;
  writing?: Int32Array;
  writer: { worker?: { thread: Worker } };
}

const openStates = new Set<StateService>();

export function openTestState(filePath: string, workerPath = sourceWorker): StateService {
  const service = new StateService(filePath, workerPath);
  openStates.add(service);
  return service;
}

export async function closeTestStates(): Promise<void> {
  const services = [...openStates];
  openStates.clear();
  await Promise.all(services.map(closeTestState));
}

async function closeTestState(service: StateService): Promise<void> {
  const internals = service as unknown as StateServiceInternals;
  const deadline = performance.now() + WRITE_SETTLE_MS;
  while (internals.writing && performance.now() < deadline) await setTimeout(10);
  const unfinished = internals.writing !== undefined;
  clearTimeout(internals.timer);
  await internals.writer.worker?.thread.terminate();
  await setTimeout(0);
  clearTimeout(internals.timer);
  internals.timer = undefined;
  if (unfinished) throw new Error("An app state write was still running when the test ended");
}
