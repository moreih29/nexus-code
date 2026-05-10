/**
 * system channel — registers workspace-agnostic OS integration handlers.
 */

import { register } from "../../router";
import { openPathExternalHandler, revealInOSHandler } from "./open-path-handler";
import { openNewWindowHandler } from "./window-handler";

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
