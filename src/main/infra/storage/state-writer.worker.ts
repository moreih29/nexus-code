import { parentPort, workerData } from "node:worker_threads";
import type { AppState } from "../../../shared/types/app-state";
import { nestedErrorText } from "../../../shared/util/nested-error-text";
import { FINISHED, PREPARING, RENAMING, writeStateFile } from "./state-file";

export type Layouts = NonNullable<AppState["layoutByWorkspace"]>;

export type StateWriteMessage =
  | { kind: "reset" }
  | { kind: "layout"; id: string; layout: Layouts[string] }
  | {
      kind: "write";
      state: AppState;
      hasLayouts: boolean;
      gate: Int32Array;
    };

export type StateWriteResult = { ready: true } | { written: boolean } | { error: string };

const port = parentPort;
if (!port) throw new Error("App state writer requires a worker port");
const filePath = workerData as string;
let layouts: Layouts = {};

port.on("message", (message: StateWriteMessage) => {
  if (message.kind === "reset") {
    layouts = {};
    return;
  }
  if (message.kind === "layout") {
    layouts[message.id] = message.layout;
    return;
  }
  const { gate, hasLayouts, state } = message;
  let result: StateWriteResult;
  try {
    if (hasLayouts) state.layoutByWorkspace = layouts;
    const written =
      Atomics.load(gate, 0) === PREPARING &&
      writeStateFile(filePath, `${filePath}.vsctmp`, state, () => {
        return Atomics.compareExchange(gate, 0, PREPARING, RENAMING) === PREPARING;
      });
    result = { written };
  } catch (error) {
    result = { error: nestedErrorText(error) };
  } finally {
    layouts = {};
    Atomics.store(gate, 0, FINISHED);
    Atomics.notify(gate, 0);
  }
  port.postMessage(result);
});
port.postMessage({ ready: true } satisfies StateWriteResult);
