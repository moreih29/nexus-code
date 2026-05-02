import { dialog } from "electron";
import { ipcContract } from "../../../shared/ipc-contract";
import { register, validateArgs } from "../router";

const c = ipcContract.dialog.call;

export function registerDialogChannel(): void {
  register("dialog", {
    call: {
      showOpenFile: async (args: unknown) => {
        const { title, defaultPath, filters } = validateArgs(c.showOpenFile.args, args);
        const result = await dialog.showOpenDialog({
          title,
          defaultPath,
          filters,
          properties: ["openFile"],
        });
        return { canceled: result.canceled, filePaths: result.filePaths };
      },
    },
    listen: {},
  });
}
