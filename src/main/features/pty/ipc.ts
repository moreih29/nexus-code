// PTY IPC channel — bridges renderer ↔ main ↔ utility(pty-host).
// Renderer calls are forwarded to the pty host via the PtyHostHandle.
// Utility events are broadcast to all renderers.

import { ipcContract } from "../../../shared/ipc-contract";
import type { WorkspaceMeta } from "../../../shared/types/workspace";
import type { StateService } from "../../infra/storage/state-service";
import type { PtyHostHandle } from "./host";
import { getDefaultShell } from "../../infra/platform/shell";
import { broadcast, register, validateArgs } from "../../infra/ipc/router";
import { TerminalRecorderRegistry, type PtyRecorderSink } from "./recorder";

const c = ipcContract.pty.call;

type PtyRoute = "utility" | "agent";

interface PtyWorkspaceContext {
  getMeta(): WorkspaceMeta;
}

export interface PtyWorkspaceManager {
  requireContext(workspaceId: string): PtyWorkspaceContext;
}

export interface PtyRouteOptions {
  agentHost?: PtyHostHandle;
  workspaceManager?: PtyWorkspaceManager;
  stateService?: Pick<StateService, "getState">;
  recorder?: PtyRecorderSink;
}

/**
 * Registers the renderer PTY IPC channel and routes each session to either
 * the legacy utility host or the workspace-scoped agent host.
 */
export function registerPtyChannel(ptyHost: PtyHostHandle, options: PtyRouteOptions = {}): void {
  const workspaceIdByTabId = new Map<string, string>();
  const routeBySession = new Map<string, PtyRoute>();
  const recorder = options.recorder ?? new TerminalRecorderRegistry();

  // Forward utility→main events to renderers
  ptyHost.on("data", (args) => {
    const {
      tabId,
      chunk,
      workspaceId: eventWorkspaceId,
    } = args as {
      workspaceId?: string;
      tabId: string;
      chunk: string;
    };
    const workspaceId = eventWorkspaceId ?? workspaceIdByTabId.get(tabId);
    if (!workspaceId) return;
    if (routeBySession.get(sessionKey(workspaceId, tabId)) === "agent") return;
    broadcast("pty", "data", { workspaceId, tabId, chunk });
  });

  ptyHost.on("exit", (args) => {
    const {
      tabId,
      code,
      workspaceId: eventWorkspaceId,
    } = args as {
      workspaceId?: string;
      tabId: string;
      code: number | null;
    };
    const workspaceId = eventWorkspaceId ?? workspaceIdByTabId.get(tabId);
    if (!workspaceId) return;
    if (routeBySession.get(sessionKey(workspaceId, tabId)) === "agent") return;
    broadcast("pty", "exit", { workspaceId, tabId, code });
    workspaceIdByTabId.delete(tabId);
    routeBySession.delete(sessionKey(workspaceId, tabId));
  });

  options.agentHost?.on("data", (args) => {
    const { workspaceId, tabId, chunk } = args as {
      workspaceId: string;
      tabId: string;
      chunk: string;
    };
    if (routeBySession.get(sessionKey(workspaceId, tabId)) === "utility") return;
    recorder.appendData(workspaceId, tabId, chunk);
    broadcast("pty", "data", { workspaceId, tabId, chunk });
  });

  options.agentHost?.on("exit", (args) => {
    const { workspaceId, tabId, code } = args as {
      workspaceId: string;
      tabId: string;
      code: number | null;
    };
    if (routeBySession.get(sessionKey(workspaceId, tabId)) === "utility") return;
    broadcast("pty", "exit", { workspaceId, tabId, code });
    recorder.stop(workspaceId, tabId);
    routeBySession.delete(sessionKey(workspaceId, tabId));
  });

  register("pty", {
    call: {
      spawn: async (args: unknown) => {
        const { workspaceId, tabId, cwd, cols, rows, env } = validateArgs(c.spawn.args, args);
        const route = routeForNewSession(workspaceId, options);
        routeBySession.set(sessionKey(workspaceId, tabId), route);
        if (route === "utility") {
          workspaceIdByTabId.set(tabId, workspaceId);
        } else {
          recorder.start(workspaceId, tabId, cols, rows);
        }
        const shell = getDefaultShell();
        try {
          const host = hostForRoute(route, ptyHost, options.agentHost);
          const result = await host.call("spawn", {
            workspaceId,
            tabId,
            cwd,
            shell,
            cols,
            rows,
            env,
          });
          return result as { pid: number };
        } catch (error) {
          workspaceIdByTabId.delete(tabId);
          recorder.stop(workspaceId, tabId);
          routeBySession.delete(sessionKey(workspaceId, tabId));
          throw error;
        }
      },

      write: (args: unknown) => {
        const { workspaceId, tabId, data } = validateArgs(c.write.args, args);
        const route = routeForSession(workspaceId, tabId, options, routeBySession);
        return hostForRoute(route, ptyHost, options.agentHost).call("write", {
          workspaceId,
          tabId,
          data,
        });
      },

      resize: (args: unknown) => {
        const { workspaceId, tabId, cols, rows } = validateArgs(c.resize.args, args);
        const route = routeForSession(workspaceId, tabId, options, routeBySession);
        const result = hostForRoute(route, ptyHost, options.agentHost).call("resize", {
          workspaceId,
          tabId,
          cols,
          rows,
        });
        if (route !== "agent") {
          return result;
        }
        return result.then((value) => {
          recorder.handleResize(workspaceId, tabId, cols, rows);
          return value;
        });
      },

      ack: (args: unknown) => {
        const { workspaceId, tabId, bytesConsumed } = validateArgs(c.ack.args, args);
        const route = routeForSession(workspaceId, tabId, options, routeBySession);
        if (route === "agent") {
          return hostForRoute(route, ptyHost, options.agentHost).call("ack", {
            workspaceId,
            tabId,
            bytesConsumed,
          });
        }
        return ptyHost.call("ack", { workspaceId, tabId, charCount: bytesConsumed });
      },

      kill: (args: unknown) => {
        const { workspaceId, tabId } = validateArgs(c.kill.args, args);
        const route = routeForSession(workspaceId, tabId, options, routeBySession);
        return hostForRoute(route, ptyHost, options.agentHost).call("kill", { workspaceId, tabId });
      },
    },
    listen: {
      data: {},
      exit: {},
    },
  });
}

/**
 * Resolves the route for a newly spawned PTY session.
 */
function routeForNewSession(workspaceId: string, options: PtyRouteOptions): PtyRoute {
  const meta = options.workspaceManager?.requireContext(workspaceId).getMeta();
  if (!meta || !options.agentHost) {
    return "utility";
  }
  if (meta.location.kind === "ssh") {
    return "agent";
  }
  return options.stateService?.getState().experimental?.ptyViaAgent === true ? "agent" : "utility";
}

/**
 * Keeps established sessions on their original host even if the flag changes.
 */
function routeForSession(
  workspaceId: string,
  tabId: string,
  options: PtyRouteOptions,
  routeBySession: ReadonlyMap<string, PtyRoute>,
): PtyRoute {
  return (
    routeBySession.get(sessionKey(workspaceId, tabId)) ?? routeForNewSession(workspaceId, options)
  );
}

/**
 * Selects the concrete PTY host for one route.
 */
function hostForRoute(
  route: PtyRoute,
  utilityHost: PtyHostHandle,
  agentHost: PtyHostHandle | undefined,
): PtyHostHandle {
  if (route === "agent") {
    if (!agentHost) {
      throw new Error("agent PTY host is not configured");
    }
    return agentHost;
  }
  return utilityHost;
}

/**
 * Builds the stable key used for PTY route bookkeeping.
 */
function sessionKey(workspaceId: string, tabId: string): string {
  return `${workspaceId}:${tabId}`;
}
