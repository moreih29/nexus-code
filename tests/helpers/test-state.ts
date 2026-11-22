import { fileURLToPath } from "node:url";
import { StateService } from "../../src/main/infra/storage/state-service";

const sourceWorker = fileURLToPath(
  new URL("../../src/main/infra/storage/state-writer.worker.ts", import.meta.url),
);

export function openTestState(filePath: string, workerPath = sourceWorker): StateService {
  return new StateService(filePath, workerPath);
}
