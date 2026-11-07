/**
 * The agent manager in main: its workspace, opened when the renderer starts
 * its program, and its reports as desktop notifications. The renderer runs
 * the manager (services/manager); main's part is what only main can do.
 */
import path from "node:path";
import { ipcContract } from "../../../shared/ipc/contract";
import { ipcOk } from "../../../shared/ipc/result";
import { createLogger } from "../../../shared/log/main";
import { MANAGER_TAB_ID } from "../../../shared/manager/manager";
import type { WorkspaceMeta } from "../../../shared/types/workspace";
import { ensureDir, root } from "../../infra/agent/runtimeDirs";
import { register, validateArgs } from "../../infra/ipc-router";
import { writeManagerCodexRules } from "./codex-rules";

const log = createLogger("manager");
const c = ipcContract.manager.call;

/** The manager's folder, which its program runs in: ~/.nexus-code/manager. */
export function managerDir(): string {
  return path.join(root(), "manager");
}

export interface ManagerFeatureOptions {
  workspaceManager: { openManagerWorkspace(rootPath: string): WorkspaceMeta };
  /** Whether a report is to be a desktop notification now: on, and the user not looking. */
  shouldNotify: () => boolean;
  /** Brings the app forward. */
  focusWindow: () => void;
  broadcast: (channel: string, event: string, args: unknown) => void;
  /** Tests pass a fake. */
  notificationCtor?: typeof import("electron").Notification;
}

// A notification nothing references can be collected before it is clicked.
const live = new Set<unknown>();

export function registerManagerChannel(options: ManagerFeatureOptions): void {
  register("manager", {
    call: {
      prepare: async () => {
        const cwd = managerDir();
        await ensureDir(cwd);
        await writeManagerCodexRules(cwd).catch((err: Error) => {
          log.warn(`the manager's Codex rules were not written: ${err.message}`);
        });
        const workspace = options.workspaceManager.openManagerWorkspace(cwd);
        return ipcOk({ workspaceId: workspace.id, tabId: MANAGER_TAB_ID, cwd });
      },
      notify: async (args: unknown) => {
        const { title, body } = validateArgs(c.notify.args, args);
        return ipcOk({ shown: notifyReport(options, title, body) });
      },
    },
    listen: { reveal: {} },
  });
}

/** Shows a report as a desktop notification, if it is to be one now. */
export function notifyReport(options: ManagerFeatureOptions, title: string, body: string): boolean {
  if (!options.shouldNotify()) return false;
  const Ctor =
    options.notificationCtor ?? (require("electron") as typeof import("electron")).Notification;
  const n = new Ctor({ title, body });
  const release = () => live.delete(n);
  n.on("click", () => {
    release();
    try {
      options.focusWindow();
      options.broadcast("manager", "reveal", {});
    } catch (error) {
      log.warn(`showing the manager failed: ${(error as Error).message}`);
    }
  });
  n.on("close", release);
  live.add(n);
  setTimeout(release, 5 * 60 * 1000).unref?.();
  n.show();
  return true;
}
