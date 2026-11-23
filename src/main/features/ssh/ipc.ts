import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FS_ERROR } from "../../../shared/fs/errors";
import type { DirEntry } from "../../../shared/fs/types";
import { DirEntrySchema } from "../../../shared/fs/types";
import { ipcContract } from "../../../shared/ipc/contract";
import { type IpcResult, ipcErr, ipcOk } from "../../../shared/ipc/result";
import { messageForSshErrorCode } from "../../infra/agent/pipe";
import type { SshAuthPromptHandler } from "../../infra/agent/ssh/auth-pty";
import { createSshChannel } from "../../infra/agent/ssh/channel";
import type { SshControlMaster } from "../../infra/agent/ssh/master";
import {
  type EnsureRemoteAgentOptions,
  ensureRemoteAgent,
  type LspBootstrapProgressEvent,
} from "../../infra/agent/ssh/ssh-bootstrap/index";
import {
  resolveSshHostConfig,
  type SshHostConfig,
  type SshTarget,
} from "../../infra/agent/ssh/ssh2/config";
import { register, validateArgs } from "../../infra/ipc-router";
import { agentCallError } from "../../infra/ipc-router/agent-errors";
import { BROWSE_MAX_ENTRIES, type SshBrowseSessionRegistry } from "./browse-session-registry";
import { parseSshConfig, type SshConfigHost } from "./config";

const c = ipcContract.ssh.call;

type SshUserTarget = Pick<SshTarget, "host" | "user" | "port" | "identityFile">;

export async function resolveSshUser(
  target: SshUserTarget,
  resolveConfig: (target: SshTarget) => Promise<Pick<SshHostConfig, "user">> = resolveSshHostConfig,
): Promise<string> {
  if (target.user && target.user.trim().length > 0) return target.user;
  try {
    const { user } = await resolveConfig({
      host: target.host,
      port: target.port,
      identityFile: target.identityFile,
    });
    if (user.length > 0) return user;
  } catch {}
  return localUserName();
}

function localUserName(): string {
  try {
    return os.userInfo().username;
  } catch {
    return process.env.USER ?? process.env.LOGNAME ?? "";
  }
}

export function registerSshChannel(configPath = path.join(os.homedir(), ".ssh", "config")): void {
  register("ssh", {
    call: {
      listConfigHosts: listConfigHostsHandler(configPath),
      openBrowseSession: openBrowseSessionStub(),
      browseSession: browseSessionStub(),
      closeBrowseSession: closeBrowseSessionStub(),
    },
    listen: {},
  });
}

export function registerSshBrowseHandlers(
  registry: SshBrowseSessionRegistry,
  promptHandler: SshAuthPromptHandler,
  broadcast?: BrowseProgressBroadcast,
): () => void {
  register("ssh", {
    call: {
      listConfigHosts: listConfigHostsHandler(),
      openBrowseSession: openBrowseSessionResultHandler(registry, promptHandler, broadcast),
      browseSession: browseSessionHandler(registry),
      closeBrowseSession: closeBrowseSessionHandler(registry),
    },
    listen: {},
  });
  return () => registry.dispose();
}

export type BrowseProgressBroadcast = (channelName: string, event: string, args: unknown) => void;

export function listConfigHostsHandler(
  configPath = path.join(os.homedir(), ".ssh", "config"),
): (args: unknown) => Promise<SshConfigHost[]> {
  return async (args: unknown): Promise<SshConfigHost[]> => {
    validateArgs(c.listConfigHosts.args, args);
    return readConfigHosts(configPath);
  };
}

async function readConfigHosts(configPath: string): Promise<SshConfigHost[]> {
  try {
    return parseSshConfig(await readFile(configPath, "utf8"));
  } catch (error) {
    if (isMissingOrPermissionError(error)) {
      return [];
    }
    throw error;
  }
}

function isMissingOrPermissionError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }

  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR" || code === "EACCES" || code === "EPERM";
}

export function openBrowseSessionHandler(
  registry: SshBrowseSessionRegistry,
  promptHandler: SshAuthPromptHandler,
  broadcast?: BrowseProgressBroadcast,
  bootstrap: (
    options: EnsureRemoteAgentOptions,
    onProgress?: (event: LspBootstrapProgressEvent) => void,
  ) => ReturnType<typeof ensureRemoteAgent> = (options, onProgress) =>
    ensureRemoteAgent(options, { promptHandler, onProgress }),
  resolveUser: (target: SshUserTarget) => Promise<string> = resolveSshUser,
): (args: unknown) => Promise<{ sessionId: string; initialPath: string; user: string }> {
  return async (
    args: unknown,
  ): Promise<{ sessionId: string; initialPath: string; user: string }> => {
    const params = validateArgs(c.openBrowseSession.args, args);

    const user = await resolveUser(params);

    const onProgress =
      params.progressId && broadcast
        ? (event: LspBootstrapProgressEvent): void => {
            broadcast("ssh", "browseProgress", {
              progressId: params.progressId,
              name: event.name,
              phase: event.phase,
              bytesDone: event.bytesDone,
              bytesTotal: event.bytesTotal,
            });
          }
        : undefined;

    const bootstrapOptions: EnsureRemoteAgentOptions = {
      host: params.host,
      user,
      port: params.port,
      identityFile: params.identityFile,
      authMode: params.authMode,
      remotePath: "/",
    };

    let bootstrapResult: Awaited<ReturnType<typeof ensureRemoteAgent>> | null = null;
    let channel: ReturnType<typeof createSshChannel> | null = null;
    try {
      bootstrapResult = await bootstrap(bootstrapOptions, onProgress);

      const masterHandle: SshControlMaster | null = bootstrapResult.controlPath
        ? buildMasterHandle(
            { ...params, user },
            bootstrapResult.controlPath,
            bootstrapResult.dispose,
          )
        : null;

      channel = createSshChannel(
        {
          host: params.host,
          user,
          port: params.port,
          identityFile: params.identityFile,
          authMode: params.authMode,
          remoteCommand: bootstrapResult.remoteCommand,
          controlPath: bootstrapResult.controlPath,
        },
        { promptHandler },
      );

      await channel.ready;

      const initialPath = bootstrapResult.remoteHome;

      const sessionId = registry.register(channel, masterHandle);
      channel = null;

      return { sessionId, initialPath, user };
    } catch (error) {
      channel?.dispose();
      bootstrapResult?.dispose?.();
      throw error;
    }
  };
}

export function openBrowseSessionResultHandler(
  registry: SshBrowseSessionRegistry,
  promptHandler: SshAuthPromptHandler,
  broadcast?: BrowseProgressBroadcast,
  bootstrap?: (
    options: EnsureRemoteAgentOptions,
    onProgress?: (event: LspBootstrapProgressEvent) => void,
  ) => ReturnType<typeof ensureRemoteAgent>,
): (args: unknown) => Promise<IpcResult<{ sessionId: string; initialPath: string; user: string }>> {
  const inner = openBrowseSessionHandler(registry, promptHandler, broadcast, bootstrap);
  return async (args: unknown) => {
    try {
      const result = await inner(args);
      return ipcOk(result);
    } catch (error) {
      const expected = agentCallError(error, "auth-failed");
      if (expected) return expected;
      throw error;
    }
  };
}

function buildMasterHandle(
  params: { host: string; user?: string; port?: number; identityFile?: string },
  controlPath: string,
  disposeBootstrap: (() => void) | undefined,
): SshControlMaster {
  return {
    controlPath,
    host: params.host,
    user: params.user,
    port: params.port,
    identityFile: params.identityFile,
    dispose: disposeBootstrap ?? (() => {}),
  };
}

export function browseSessionHandler(
  registry: SshBrowseSessionRegistry,
): (args: unknown) => Promise<IpcResult<{ entries: DirEntry[]; truncated: boolean }>> {
  return async (args: unknown) => {
    const { sessionId, path: dirPath } = validateArgs(c.browseSession.args, args);

    const session = registry.get(sessionId);
    if (!session) {
      const code = "ssh.session-expired";
      return ipcErr("session-expired", messageForSshErrorCode(code), {
        category: "failed",
        domain: "ssh",
        code,
      });
    }

    let rawEntries: unknown;
    try {
      rawEntries = await session.channel.call("fs.readdir", { relPath: dirPath });
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === FS_ERROR.NOT_FOUND) {
        const code = "ssh.path-not-found";
        return ipcErr("not-found", messageForSshErrorCode(code), {
          category: "failed",
          domain: "ssh",
          code,
        });
      }
      const expected = agentCallError(error);
      if (expected) return expected;
      throw error;
    }

    const allEntries = DirEntrySchema.array().parse(rawEntries);

    const truncated = allEntries.length > BROWSE_MAX_ENTRIES;
    const entries = truncated ? allEntries.slice(0, BROWSE_MAX_ENTRIES) : allEntries;

    return ipcOk({ entries, truncated });
  };
}

export function closeBrowseSessionHandler(registry: SshBrowseSessionRegistry) {
  return (args: unknown) => {
    const { sessionId } = validateArgs(c.closeBrowseSession.args, args);
    registry.close(sessionId);
    return ipcOk(undefined);
  };
}

function openBrowseSessionStub(): (args: unknown) => Promise<never> {
  return async (_args: unknown): Promise<never> => {
    throw new Error("SSH browse session handler not registered");
  };
}

function browseSessionStub(): (args: unknown) => Promise<never> {
  return async (_args: unknown): Promise<never> => {
    throw new Error("SSH browse session handler not registered");
  };
}

function closeBrowseSessionStub(): (args: unknown) => void {
  return (_args: unknown): void => {
    throw new Error("SSH browse session handler not registered");
  };
}
