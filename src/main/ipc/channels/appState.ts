import { ipcContract } from "../../../shared/ipc-contract";
import type { StateService } from "../../storage/stateService";
import { register, validateArgs } from "../router";

const c = ipcContract.appState.call;

export function registerAppStateChannel(stateService: StateService): void {
  register("appState", {
    call: {
      get: (_args: unknown) => {
        return stateService.getState();
      },
      set: (args: unknown) => {
        const patch = validateArgs(c.set.args, args);
        stateService.setState(patch);
      },
    },
    listen: {},
  });
}
