import { ipcContract } from "../../../shared/ipc/contract";
import { ipcErr, ipcOk } from "../../../shared/ipc/result";
import { register, validateArgs } from "../../infra/ipc-router";
import { handleGitHandlerError } from "../git/ipc/git-result";
import { createTask, removeTask, TaskError, type TaskServiceDeps } from "./service";

const c = ipcContract.task.call;

export function registerTaskChannel(deps: TaskServiceDeps): void {
  register("task", {
    call: {
      create: async (args: unknown) => {
        try {
          return ipcOk(await createTask(deps, validateArgs(c.create.args, args)));
        } catch (error) {
          return taskErrorResult(error);
        }
      },
      remove: async (args: unknown) => {
        try {
          await removeTask(deps, validateArgs(c.remove.args, args));
          return ipcOk(undefined);
        } catch (error) {
          return taskErrorResult(error);
        }
      },
    },
    listen: {},
  });
}

function taskErrorResult(error: unknown) {
  if (error instanceof TaskError) return ipcErr(error.kind, error.message);
  return handleGitHandlerError(error);
}
