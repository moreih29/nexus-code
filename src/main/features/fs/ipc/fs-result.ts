import { type IpcResult, ipcOk } from "../../../../shared/ipc/result";
import { agentCallError } from "../../../infra/ipc-router/agent-errors";
import { fsCallError } from "../../../infra/ipc-router/fs-errors";

/** Envelopes a file operation, including failures while resolving its provider. */
export async function runFsCall<T>(run: () => Promise<T>): Promise<IpcResult<T>> {
  try {
    return ipcOk(await run());
  } catch (error) {
    const expected = fsCallError(error) ?? agentCallError(error);
    if (expected) return expected;
    throw error;
  }
}
