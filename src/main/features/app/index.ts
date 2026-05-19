// src/main/features/app/index.ts — Application lifecycle IPC channel.
//
// Registers the `app` channel, which exposes one-shot lifecycle commands.
// Intentionally separate from `appState` (KV persistence channel) to
// preserve cohesion — restart is an imperative command, not a state write.

import { app } from "electron";
import { z } from "zod";
import { ipcOk } from "../../../shared/ipc/result";
import { createLogger } from "../../../shared/log/main";
import { register, validateArgs } from "../../infra/ipc-router";
import type { StateService } from "../../infra/storage/state-service";

const logger = createLogger("app");

const RestartArgsSchema = z.object({
  reason: z.string().min(1).max(120),
});

/**
 * Register the `app` lifecycle channel.
 *
 * Exposed methods:
 *   - `restart({ reason })` — flush persisted state, then relaunch the app.
 *     `reason` is a diagnostic string written to the log for post-mortem
 *     analysis (e.g. "opacity-change", "theme-reset").
 *
 * The handler defers `app.relaunch` + `app.exit(0)` into a `setImmediate`
 * callback so the IPC response envelope is delivered to the renderer before
 * the main process exits.  Without the deferral the IPC channel closes before
 * Electron can serialise the reply, which silently drops the result and leaves
 * the renderer promise hanging.
 */
export function registerAppChannel(stateService: StateService): void {
  register("app", {
    call: {
      restart: (args: unknown) => {
        const { reason } = validateArgs(RestartArgsSchema, args);

        logger.info(`[app] restart requested: ${reason}`);

        // Flush persisted state synchronously before relaunch so no in-memory
        // writes are lost.  StateService.flushNow() is synchronous
        // (fs.writeFileSync + fs.renameSync), providing a durability guarantee
        // before the process exits.
        try {
          stateService.flushNow();
        } catch (flushErr) {
          // Flush failure is non-fatal: log and proceed.  Losing the last
          // write is preferable to aborting the restart entirely.
          logger.warn(
            `[app] stateService flushNow before restart failed: ${
              flushErr instanceof Error ? flushErr.message : String(flushErr)
            }`,
          );
        }

        // Defer app.relaunch + app.exit so the IPC response envelope is sent
        // before the main process terminates and closes the IPC channel.
        setImmediate(() => {
          app.relaunch({ args: process.argv.slice(1) });
          app.exit(0);
        });

        return ipcOk(undefined);
      },
    },
    listen: {},
  });
}
