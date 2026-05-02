import { ipcContract } from "../../../shared/ipc-contract";
import { register, validateArgs } from "../router";
import type { WorkspaceManager } from "../../workspace/WorkspaceManager";

const c = ipcContract.workspace.call;

export function registerWorkspaceChannel(manager: WorkspaceManager): void {
  register("workspace", {
    call: {
      list: (_args: unknown) => {
        return manager.list();
      },
      create: (args: unknown) => {
        const { rootPath, name } = validateArgs(c.create.args, args);
        return manager.create({ rootPath, name });
      },
      update: (args: unknown) => {
        const { id, ...partial } = validateArgs(c.update.args, args);
        return manager.update(id, partial);
      },
      remove: (args: unknown) => {
        const { id } = validateArgs(c.remove.args, args);
        manager.remove(id);
      },
      activate: (args: unknown) => {
        const { id } = validateArgs(c.activate.args, args);
        manager.activate(id);
      },
    },
    listen: {
      changed: {},
      attention: {},
    },
  });
}
