import path from "node:path";
import { dialog } from "electron";
import { ipcContract } from "../../../shared/ipc/contract";
import { register, validateArgs } from "../../infra/ipc-router";
import { getMainT } from "../../i18n";

const c = ipcContract.dialog.call;

/**
 * The renderer builds Windows default paths as `C:/work/demo/x`; the native
 * dialog wants backslashes.
 */
function toNativeDefaultPath(defaultPath: string | undefined): string | undefined {
  return defaultPath && process.platform === "win32" ? path.normalize(defaultPath) : defaultPath;
}

export function registerDialogChannel(): void {
  register("dialog", {
    call: {
      showOpenFile: async (args: unknown) => {
        const { title, defaultPath, filters } = validateArgs(c.showOpenFile.args, args);
        const t = getMainT();
        const result = await dialog.showOpenDialog({
          title: title ?? t("dialog:openFile.title"),
          defaultPath: toNativeDefaultPath(defaultPath),
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
          defaultPath: toNativeDefaultPath(defaultPath),
          properties: ["openDirectory", "createDirectory"],
        });
        return { canceled: result.canceled, filePaths: result.filePaths };
      },
      showSaveDialog: async (args: unknown) => {
        const opts = validateArgs(c.showSaveDialog.args, args) ?? {};
        const t = getMainT();
        const result = await dialog.showSaveDialog({
          title: opts.title ?? t("dialog:saveFile.title"),
          defaultPath: toNativeDefaultPath(opts.defaultPath),
          filters: opts.filters,
          // The renderer overwrites the picked file, so every platform must
          // ask first; macOS and Windows always do, Linux only on request.
          properties: ["showOverwriteConfirmation"],
        });
        return { canceled: result.canceled, filePath: result.filePath };
      },
    },
    listen: {},
  });
}
