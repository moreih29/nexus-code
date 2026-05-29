import { dialog } from "electron";
import { ipcContract } from "../../../shared/ipc/contract";
import { register, validateArgs } from "../../infra/ipc-router";
import { getMainT } from "../../i18n";

const c = ipcContract.dialog.call;

export function registerDialogChannel(): void {
  register("dialog", {
    call: {
      showOpenFile: async (args: unknown) => {
        const { title, defaultPath, filters } = validateArgs(c.showOpenFile.args, args);
        const t = getMainT();
        const result = await dialog.showOpenDialog({
          title: title ?? t("dialog:openFile.title"),
          defaultPath,
          filters,
          properties: ["openFile"],
        });
        return { canceled: result.canceled, filePaths: result.filePaths };
      },
      showOpenDirectory: async (args: unknown) => {
        const { title, defaultPath } = validateArgs(c.showOpenDirectory.args, args);
        const t = getMainT();
        const result = await dialog.showOpenDialog({
          title: title ?? t("dialog:openDirectory.title"),
          defaultPath,
          properties: ["openDirectory", "createDirectory"],
        });
        return { canceled: result.canceled, filePaths: result.filePaths };
      },
      showSaveDialog: async (args: unknown) => {
        const opts = validateArgs(c.showSaveDialog.args, args) ?? {};
        const t = getMainT();
        const result = await dialog.showSaveDialog({
          title: opts.title ?? t("dialog:saveFile.title"),
          defaultPath: opts.defaultPath,
          filters: opts.filters,
        });
        return { canceled: result.canceled, filePath: result.filePath };
      },
    },
    listen: {},
  });
}
