import { ipcContract } from "../../../shared/ipc/contract";
import type { SystemStats } from "../../../shared/system/stats";
import { register, validateArgs } from "../../infra/ipc-router";
import { appErrors, type RecordError } from "../../infra/recent-errors";
import { openNewWindowHandler } from "../window/ipc";
import { fontNames } from "./font-names";
import { logsPathHandler, openLogsFolderHandler } from "./logs";
import {
  getElectronSystemShell,
  type LocalWorkspaceRoots,
  openPathExternalHandler,
  revealInOSHandler,
} from "./open-path";

export interface RegisterSystemChannelOptions {
  readonly openNewWindow?: () => unknown;
  readonly stats?: (args: unknown) => Promise<SystemStats | null>;
  readonly recordError?: RecordError;
  readonly localWorkspaceRoots?: LocalWorkspaceRoots;
}

export function registerSystemChannel(options: RegisterSystemChannelOptions = {}): void {
  register("system", {
    call: {
      openPathExternal: openPathExternalHandler(
        getElectronSystemShell(),
        options.localWorkspaceRoots,
      ),
      revealInOS: revealInOSHandler(getElectronSystemShell(), options.localWorkspaceRoots),
      logsPath: logsPathHandler(),
      openLogsFolder: openLogsFolderHandler(),
      openNewWindow: openNewWindowHandler(options.openNewWindow ?? (() => {})),
      stats: options.stats ?? (async () => null),
      fontNames: async () => ({ groups: await fontNames() }),
      recordError: async (args: unknown) => {
        const { area, code, status, message } = validateArgs(
          ipcContract.system.call.recordError.args,
          args,
        );
        (options.recordError ?? appErrors.record)(area, code, status, message);
      },
    },
    listen: {},
  });
}
