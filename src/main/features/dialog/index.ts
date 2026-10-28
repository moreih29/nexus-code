import path from "node:path";
import { dialog } from "electron";
import { toNativeDrivePath } from "../../../shared/fs/drive-path";
import { ipcContract } from "../../../shared/ipc/contract";
import { register, validateArgs } from "../../infra/ipc-router";
import { getMainT } from "../../i18n";

const c = ipcContract.dialog.call;

/**
 * The renderer builds Windows default paths as `C:/work/demo/x`; the native
 * dialog wants backslashes.
 */
function toNativeDefaultPath(defaultPath: string | undefined): string | undefined {
  return defaultPath && toNativeDrivePath(defaultPath);
}

// Electron opens a dialog given no defaultPath in Downloads, and the OS no
// longer brings back the folder the last one was in, so the dialogs remember it.
let lastFolder: string | undefined;

function startPath(defaultPath: string | undefined): string | undefined {
  return toNativeDefaultPath(defaultPath) ?? lastFolder;
}

function rememberFolderOf(chosen: string | undefined): void {
  if (chosen) lastFolder = path.dirname(chosen);
}

/** Forgets the remembered folder, so each test starts from none. */
export function forgetLastDialogFolder(): void {
  lastFolder = undefined;
}

export function registerDialogChannel(): void {
  register("dialog", {
    call: {
      showOpenFile: async (args: unknown) => {
        const { title, defaultPath, filters } = validateArgs(c.showOpenFile.args, args);
        const t = getMainT();
        const result = await dialog.showOpenDialog({
          title: title ?? t("dialog:openFile.title"),
          defaultPath: startPath(defaultPath),
          filters,
          properties: ["openFile"],
        });
        rememberFolderOf(result.filePaths[0]);
        return { canceled: result.canceled, filePaths: result.filePaths };
      },
      showOpenDirectory: async (args: unknown) => {
        const { title, defaultPath } = validateArgs(c.showOpenDirectory.args, args);
        const t = getMainT();
        const result = await dialog.showOpenDialog({
          title: title ?? t("dialog:openDirectory.title"),
          defaultPath: startPath(defaultPath),
          properties: ["openDirectory", "createDirectory"],
        });
        rememberFolderOf(result.filePaths[0]);
        return { canceled: result.canceled, filePaths: result.filePaths };
      },
      showSaveDialog: async (args: unknown) => {
        const opts = validateArgs(c.showSaveDialog.args, args) ?? {};
        const t = getMainT();
        const result = await dialog.showSaveDialog({
          title: opts.title ?? t("dialog:saveFile.title"),
          defaultPath: startPath(opts.defaultPath),
          filters: opts.filters,
          // The renderer overwrites the picked file, so every platform must
          // ask first; macOS and Windows always do, Linux only on request.
          properties: ["showOverwriteConfirmation"],
        });
        rememberFolderOf(result.filePath);
        return { canceled: result.canceled, filePath: result.filePath };
      },
    },
    listen: {},
  });
}
