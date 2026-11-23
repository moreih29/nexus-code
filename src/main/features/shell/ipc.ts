import type { SystemStats } from "../../../shared/system/stats";
import { register } from "../../infra/ipc-router";
import { openNewWindowHandler } from "../window/ipc";
import { fontNames } from "./font-names";
import { logsPathHandler, openLogsFolderHandler } from "./logs";
import { openPathExternalHandler, revealInOSHandler } from "./open-path";

export interface RegisterSystemChannelOptions {
  readonly openNewWindow?: () => unknown;
  readonly stats?: (args: unknown) => Promise<SystemStats | null>;
}

export function registerSystemChannel(options: RegisterSystemChannelOptions = {}): void {
  register("system", {
    call: {
      openPathExternal: openPathExternalHandler(),
      revealInOS: revealInOSHandler(),
      logsPath: logsPathHandler(),
      openLogsFolder: openLogsFolderHandler(),
      openNewWindow: openNewWindowHandler(options.openNewWindow ?? (() => {})),
      stats: options.stats ?? (async () => null),
      fontNames: async () => ({ groups: await fontNames() }),
    },
    listen: {},
  });
}
