/**
 * Autofetch channel — schedule/pause/resume controls for the background
 * fetch scheduler. Actual user-triggered fetch work is exposed as
 * `git.fetchAll` so Source Control actions stay grouped under the git channel.
 */
import { ipcContract } from "../../../shared/ipc-contract";
import type { GitAutofetchScheduler } from "../../git/git-autofetch";
import { register, validateArgs } from "../router";

const c = ipcContract.autofetch.call;

/** Registers top-level autofetch IPC calls and listen event placeholders. */
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
