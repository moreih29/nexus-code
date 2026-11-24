import { mergeAgentEnv, profileVariables } from "../../../shared/agent-profiles/env";
import { ipcContract } from "../../../shared/ipc/contract";
import { ipcErr, ipcOk } from "../../../shared/ipc/result";
import type { WorkspacePorts } from "../../../shared/pty/ports";
import type { CustomShell, ShellChoice } from "../../../shared/pty/shell";
import { broadcast, register, validateArgs } from "../../infra/ipc-router";
import { getActiveAppWindow, getFocusedAppWindow } from "../window/app-windows";
import { ForwardError, type PortForwards } from "./forwards";
import { injectHarnessTerminalEnv } from "./harness-env";
import type { WorkspaceNameLookup } from "./osc-notification";
import { OscNotificationDispatcher } from "./osc-notification";
import { applyShellPathShim } from "./shell-shim";
import {
  detectShells,
  findShellProgram,
  nodeShellHost,
  resolveShellChoice,
  type ShellHost,
  systemDefaultShell,
} from "./shells";
import type { PtyHostHandle } from "./types";
import { applyWindowsShellShim, type WindowsAgentFiles } from "./windows-shell-shim";

const c = ipcContract.pty.call;
type SpawnRequest = ReturnType<typeof validateArgs<typeof c.spawn.args>>;

export interface PtyChannelOptions {
  agentHost: PtyHostHandle;
  workspaceManager?: WorkspaceNameLookup & {
    connect(id: string): Promise<void>;
    getAgentChannel(workspaceId: string): Promise<unknown>;
    getWrapperBinDir(workspaceId: string): string | null;
    getWrapperAgentBin(workspaceId: string): string | null;
    getWrapperShell(workspaceId: string): string | null;
    getWrapperShimDir(workspaceId: string): string | null;
    isLocal?(workspaceId: string): boolean;
  };
  profileEnv?: (workspaceId: string, profileId?: string) => Promise<Record<string, string> | null>;
  getDefaultShell?: () => ShellChoice | undefined;
  getCustomShells?: () => readonly CustomShell[] | undefined;
  shellHost?: ShellHost;
  windowsAgentFiles?: () => Promise<WindowsAgentFiles | null>;
  isActiveTab?: (workspaceId: string, tabId: string) => boolean;
  notificationsEnabled?: () => boolean;
  onInput?: (workspaceId: string, tabId: string, data: string) => void;
  onResize?: (workspaceId: string, tabId: string) => void;
  ports?: { snapshot(): WorkspacePorts[] };
  forwards?: PortForwards;
}

export function registerPtyChannel(options: PtyChannelOptions): void {
  const { agentHost } = options;
  const wm = options.workspaceManager;
  const sessionShellPaths = new Map<string, string>();
  const sessionKey = (workspaceId: string, tabId: string) => `${workspaceId}:${tabId}`;
  const spawnsInFlight = new Map<string, Promise<unknown>>();
  const dispatcher = new OscNotificationDispatcher({
    workspaceManager: wm ?? { getName: () => null },
    getFocusedWindow: getFocusedAppWindow,
    isActiveTab: options.isActiveTab,
    notificationsEnabled: options.notificationsEnabled,
    connectWorkspace: wm ? (id) => wm.connect(id) : undefined,
    focusMainWindow: () => {
      const win = getActiveAppWindow();
      if (!win) return;
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    },
  });

  agentHost.on("data", (args) => {
    const { workspaceId, tabId, chunk, replay } = args as {
      workspaceId: string;
      tabId: string;
      chunk: string;
      replay?: boolean;
    };
    if (!replay) dispatcher.handleChunk(workspaceId, tabId, chunk);
    broadcast(
      "pty",
      "data",
      replay ? { workspaceId, tabId, chunk, replay } : { workspaceId, tabId, chunk },
    );
  });

  agentHost.on("exit", (args) => {
    const { workspaceId, tabId, code } = args as {
      workspaceId: string;
      tabId: string;
      code: number | null;
    };
    broadcast("pty", "exit", { workspaceId, tabId, code });
    sessionShellPaths.delete(sessionKey(workspaceId, tabId));
  });

  agentHost.on("held", (args) => {
    const { workspaceId, tabId } = args as { workspaceId: string; tabId: string };
    broadcast("pty", "held", { workspaceId, tabId });
  });

  agentHost.on("restored", (args) => {
    const { workspaceId, tabId, withReplay } = args as {
      workspaceId: string;
      tabId: string;
      withReplay: boolean;
    };
    broadcast("pty", "restored", { workspaceId, tabId, withReplay });
  });

  agentHost.on("expired", (args) => {
    const { workspaceId, tabId } = args as { workspaceId: string; tabId: string };
    broadcast("pty", "expired", { workspaceId, tabId });
  });

  const spawnSession = async (request: SpawnRequest) => {
    const {
      workspaceId,
      tabId,
      cwd,
      cols,
      rows,
      env: givenEnv,
      args: spawnArgs,
      shell: tabShell,
      profile,
    } = request;
    const windows = options.windowsAgentFiles !== undefined && wm?.isLocal?.(workspaceId) !== false;
    let env = givenEnv;
    if (profile !== undefined || options.profileEnv) {
      const fromProfile = await options.profileEnv?.(workspaceId, profile);
      if (profile !== undefined && !fromProfile) {
        return ipcErr("not-found", `no profile ${profile}`, { category: "failed" });
      }
      env = mergeAgentEnv(
        windows,
        givenEnv ?? {},
        profileVariables(fromProfile ?? undefined, windows),
        { NEXUS_TERMINAL_PROFILE_ID: profile ?? "" },
      );
    }
    if (wm) await wm.getAgentChannel(workspaceId);
    const wrapperBinDir = wm?.getWrapperBinDir(workspaceId) ?? null;
    const wrapperAgentBin = wm?.getWrapperAgentBin(workspaceId) ?? null;
    let enrichedEnv =
      wrapperBinDir !== null
        ? injectHarnessTerminalEnv(env, {
            binDir: wrapperBinDir,
            workspaceId,
            tabId,
            agentBin: wrapperAgentBin ?? undefined,
          })
        : injectHarnessTerminalEnv(env);

    let shell: { path: string; args: string[] } | undefined;
    let shellPath: string | undefined;
    let missingShell: string | undefined;
    if (wm?.isLocal?.(workspaceId)) {
      const host = options.shellHost ?? nodeShellHost();
      const customShells = options.getCustomShells?.();
      for (const choice of [tabShell, options.getDefaultShell?.()]) {
        if (choice === undefined) continue;
        const resolved = resolveShellChoice(host, choice, customShells);
        if ("shell" in resolved) {
          shell = resolved.shell;
          break;
        }
        missingShell ??= resolved.missing;
      }
      shellPath = shell?.path ?? systemDefaultShell(host).path;
    }

    let shimmedArgs: string[] | undefined = shell?.args ?? spawnArgs;
    if (wrapperBinDir !== null && options.windowsAgentFiles && shellPath !== undefined) {
      const files = await options.windowsAgentFiles();
      const shimResult = applyWindowsShellShim({
        shell: shellPath,
        env: mergeAgentEnv(windows, enrichedEnv),
        args: shimmedArgs,
        settingsPath: files?.settingsPath,
        serverlessSettingsPath: files?.serverlessSettingsPath,
        wrapperDir: files?.binDir,
        ...(files ? { codex: { cmdLauncherDir: files.cmdLauncherDir } } : {}),
        originalPath: process.env.ORIGINAL_PATH,
      });
      enrichedEnv = shimResult.env;
      shimmedArgs = shimResult.args;
      shell ??= { path: shellPath, args: [] };
    } else if (wrapperBinDir !== null) {
      const wrapperShell = shell?.path ?? wm?.getWrapperShell(workspaceId) ?? null;
      const wrapperShimDir = wm?.getWrapperShimDir(workspaceId) ?? null;
      if (wrapperShell !== null && wrapperShimDir !== null) {
        const shimResult = applyShellPathShim({
          shell: wrapperShell,
          env: enrichedEnv,
          args: shimmedArgs,
          shimDir: wrapperShimDir,
        });
        enrichedEnv = shimResult.env;
        shimmedArgs = shimResult.args;
      }
    }

    const result = (await agentHost.call("spawn", {
      workspaceId,
      tabId,
      cwd,
      cols,
      rows,
      env: enrichedEnv,
      ...(shell !== undefined ? { shell: shell.path } : {}),
      ...(shimmedArgs !== undefined && shimmedArgs.length > 0 ? { args: shimmedArgs } : {}),
    })) as { pid: number; attached?: boolean };
    const key = sessionKey(workspaceId, tabId);
    if (result.attached) {
      const running = sessionShellPaths.get(key);
      return { pid: result.pid, ...(running !== undefined ? { shellPath: running } : {}) };
    }
    if (shellPath !== undefined) sessionShellPaths.set(key, shellPath);
    return {
      pid: result.pid,
      ...(shellPath !== undefined ? { shellPath } : {}),
      ...(missingShell !== undefined ? { missingShell } : {}),
    };
  };

  register("pty", {
    call: {
      spawn: async (args: unknown) => {
        const request = validateArgs(c.spawn.args, args);
        const key = sessionKey(request.workspaceId, request.tabId);
        const run = spawnSession(request);
        spawnsInFlight.set(key, run);
        const forget = () => {
          if (spawnsInFlight.get(key) === run) spawnsInFlight.delete(key);
        };
        run.then(forget, forget);
        return run;
      },

      write: async (args: unknown) => {
        const { workspaceId, tabId, data } = validateArgs(c.write.args, args);
        options.onInput?.(workspaceId, tabId, data);
        try {
          const sent = await agentHost.call("write", { workspaceId, tabId, data });
          if (sent === undefined) return ipcErr("cancelled", "Terminal input was skipped");
          return ipcOk(undefined);
        } catch (error) {
          return ipcErr("terminal-input-failed", String(error), {
            category: "failed",
            code: "terminal-input-failed",
          });
        }
      },

      resize: async (args: unknown) => {
        const { workspaceId, tabId, cols, rows } = validateArgs(c.resize.args, args);
        options.onResize?.(workspaceId, tabId);
        await agentHost.call("resize", { workspaceId, tabId, cols, rows });
        return ipcOk(undefined);
      },

      ack: async (args: unknown) => {
        const { workspaceId, tabId, bytesConsumed } = validateArgs(c.ack.args, args);
        await agentHost.call("ack", { workspaceId, tabId, bytesConsumed });
        return ipcOk(undefined);
      },

      kill: async (args: unknown) => {
        const { workspaceId, tabId } = validateArgs(c.kill.args, args);
        await spawnsInFlight.get(sessionKey(workspaceId, tabId))?.catch(() => {});
        await agentHost.call("kill", { workspaceId, tabId });
        return ipcOk(undefined);
      },

      foregroundProcess: async (args: unknown) => {
        const { workspaceId, tabId } = validateArgs(c.foregroundProcess.args, args);
        const result = (await agentHost.call("foregroundProcess", { workspaceId, tabId })) as
          | { name: string }
          | undefined;
        return ipcOk({ name: result?.name ?? "" });
      },

      listShells: async () => {
        const host = options.shellHost ?? nodeShellHost();
        return ipcOk({ shells: detectShells(host), systemDefault: systemDefaultShell(host) });
      },

      findShell: async (args: unknown) => {
        const { program } = validateArgs(c.findShell.args, args);
        return ipcOk({ path: findShellProgram(options.shellHost ?? nodeShellHost(), program) });
      },

      ports: async () => ipcOk(options.ports?.snapshot() ?? []),

      forwards: async () => ipcOk(options.forwards?.snapshot() ?? []),

      forward: async (args: unknown) => {
        const { workspaceId, port } = validateArgs(c.forward.args, args);
        const forwards = options.forwards;
        if (!forwards) return ipcErr("not-ssh", "ports are not forwarded here");
        try {
          return ipcOk(await forwards.forward(workspaceId, port));
        } catch (error) {
          return forwardFailure(error);
        }
      },

      unforward: async (args: unknown) => {
        const { workspaceId, port } = validateArgs(c.unforward.args, args);
        await options.forwards?.stop(workspaceId, port);
        return ipcOk(undefined);
      },

      localUrl: async (args: unknown) => {
        const { workspaceId, url } = validateArgs(c.localUrl.args, args);
        const forwards = options.forwards;
        if (!forwards) return ipcOk({ url });
        try {
          return ipcOk({ url: await forwards.localUrl(workspaceId, url) });
        } catch (error) {
          return forwardFailure(error);
        }
      },
    },
    listen: {
      ports: {},
      forwards: {},
      data: {},
      exit: {},
      notificationClick: {},
      held: {},
      restored: {},
      expired: {},
    },
  });
}

function forwardFailure(error: unknown) {
  if (error instanceof ForwardError) return ipcErr(error.kind, error.reason);
  return ipcErr("failed", (error as Error).message);
}
