/**
 * system channel — registers workspace-agnostic shell/window handlers.
 */

import type { SystemStats } from "../../../shared/system/stats";
import { register } from "../../infra/ipc-router";
import { openNewWindowHandler } from "../window/ipc";
import { fontNames } from "./font-names";
import { openPathExternalHandler, revealInOSHandler } from "./open-path";

export interface RegisterSystemChannelOptions {
  readonly openNewWindow?: () => unknown;
  /** system.stats; null for every ask when not given. */
  readonly stats?: (args: unknown) => Promise<SystemStats | null>;
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
      stats: options.stats ?? (async () => null),
      fontNames: async () => ({ groups: await fontNames() }),
    },
    listen: {},
  });
}
