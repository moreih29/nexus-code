/**
 * system channel — registers workspace-agnostic shell/window handlers.
 */

import { register } from "../../infra/ipc/router";
import { openNewWindowHandler } from "../window/ipc";
import { openPathExternalHandler, revealInOSHandler } from "./open-path";

export interface RegisterSystemChannelOptions {
  readonly openNewWindow?: () => unknown;
}

/**
 * Register system IPC calls that operate on absolute paths and do not depend
 * on workspace storage or Git repository state.
 */
export function registerSystemChannel(options: RegisterSystemChannelOptions = {}): void {
  register("system", {
    call: {
      openPathExternal: openPathExternalHandler(),
      revealInOS: revealInOSHandler(),
      openNewWindow: openNewWindowHandler(options.openNewWindow ?? (() => {})),
    },
    listen: {},
  });
}
