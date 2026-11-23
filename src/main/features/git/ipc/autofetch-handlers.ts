import { ipcContract } from "../../../../shared/ipc/contract";
import { register, validateArgs } from "../../../infra/ipc-router";
import type { GitAutofetchScheduler } from "../domain/autofetch";

const c = ipcContract.autofetch.call;

export function registerAutofetchChannel(scheduler: GitAutofetchScheduler): void {
  register("autofetch", {
    call: {
      setSchedule(args: unknown): void {
        const { workspaceId, intervalMin } = validateArgs(c.setSchedule.args, args);
        scheduler.setSchedule(workspaceId, intervalMin);
      },
      pause(args: unknown): void {
        const { workspaceId } = validateArgs(c.pause.args, args);
        scheduler.pause(workspaceId);
      },
      resume(args: unknown): void {
        const { workspaceId } = validateArgs(c.resume.args, args);
        scheduler.resume(workspaceId);
      },
    },
    listen: {
      stateChanged: {},
    },
  });
}
