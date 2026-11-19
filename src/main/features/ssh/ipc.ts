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

/** The host fields a browse session connects with. */
type SshUserTarget = Pick<SshTarget, "host" | "user" | "port" | "identityFile">;

/**
 * Resolves the SSH login user. When the caller leaves `user` unset — the user
 * typed only a host — it is the user `ssh <host>` logs in as: the config's
 * User for that host as `ssh -G` prints it (Include files, `Host *` and Match
 * blocks too), else the local account name.
 */
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
  } catch {
    // Fall through to the local account, as plain `ssh` would without a config.
  }
  return localUserName();
}

function localUserName(): string {
  try {
    return os.userInfo().username;
  } catch {
    return process.env.USER ?? process.env.LOGNAME ?? "";
  }
}

/**
 * Registers SSH-related main-process IPC handlers.
 */
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

/**
 * Registers the three browse-session IPC handlers against an existing registry.
 * Call this after registerSshChannel() with a wired registry so browse calls
 * route to the real implementation.
 *
 * The returned dispose function tears down the registry on shutdown.
 */
export function registerSshBrowseHandlers(
  registry: SshBrowseSessionRegistry,
  promptHandler: SshAuthPromptHandler,
  // Optional so existing callers/tests that don't care about progress keep
  // working; when supplied, openBrowseSession streams bootstrap progress to
  // the renderer via the `ssh.browseProgress` event keyed by progressId.
  broadcast?: BrowseProgressBroadcast,
): () => void {
  register("ssh", {
    call: {
      listConfigHosts: listConfigHostsHandler(),
      // openBrowseSession is migrated to the T1 IpcResult contract so auth
      // cancellation arrives at the renderer as ipcErr("cancelled") — the
      // router passes the envelope silently without logging, and the
      // renderer uses ipcCallResult to branch on result.kind.
      openBrowseSession: openBrowseSessionResultHandler(registry, promptHandler, broadcast),
      browseSession: browseSessionHandler(registry),
      closeBrowseSession: closeBrowseSessionHandler(registry),
    },
    listen: {},
  });
  return () => registry.dispose();
}

/**
 * Broadcast fn shape used to push browse-session bootstrap progress to the
 * renderer — matches the main-process forwardBroadcast signature.
 */
export type BrowseProgressBroadcast = (channelName: string, event: string, args: unknown) => void;

// ---------------------------------------------------------------------------
// listConfigHosts
// ---------------------------------------------------------------------------

/**
 * Builds the listConfigHosts IPC handler with an injectable config path.
 */
export function listConfigHostsHandler(
  configPath = path.join(os.homedir(), ".ssh", "config"),
): (args: unknown) => Promise<SshConfigHost[]> {
  return async (args: unknown): Promise<SshConfigHost[]> => {
    validateArgs(c.listConfigHosts.args, args);
    return readConfigHosts(configPath);
  };
}

/**
 * Reads an ssh config file and returns concrete Host entries.
 */
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

/**
 * Identifies missing or unreadable ssh config files.
 */
function isMissingOrPermissionError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }

  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR" || code === "EACCES" || code === "EPERM";
}

// ---------------------------------------------------------------------------
// openBrowseSession
// ---------------------------------------------------------------------------

/**
 * Builds the openBrowseSession IPC handler.
 *
 * Authenticates a ControlMaster once, opens an agent channel over it, and
 * registers the live session in the registry. Returns {sessionId, initialPath}.
 * The channel is NOT disposed at the end — it stays alive for subsequent
 * browseSession calls. The caller must close it via closeBrowseSession.
 */
export function openBrowseSessionHandler(
  registry: SshBrowseSessionRegistry,
  promptHandler: SshAuthPromptHandler,
  broadcast?: BrowseProgressBroadcast,
  bootstrap: (
    options: EnsureRemoteAgentOptions,
    onProgress?: (event: LspBootstrapProgressEvent) => void,
  ) => ReturnType<typeof ensureRemoteAgent> = (options, onProgress) =>
    // The promptHandler MUST be forwarded to ensureRemoteAgent — without it
    // createBootstrapContext skips interactive auth and password-only hosts
    // fail before the agent channel is ever opened.
    ensureRemoteAgent(options, { promptHandler, onProgress }),
  resolveUser: (target: SshUserTarget) => Promise<string> = resolveSshUser,
): (args: unknown) => Promise<{ sessionId: string; initialPath: string; user: string }> {
  return async (
    args: unknown,
  ): Promise<{ sessionId: string; initialPath: string; user: string }> => {
    const params = validateArgs(c.openBrowseSession.args, args);

    // Host-only input leaves `user` unset — resolve the one ssh would use, so
    // the connection (and the saved profile) has a concrete user that does
    // not override the config's.
    const user = await resolveUser(params);

    // Stream agent-bootstrap progress to the renderer for this connect attempt.
    // Keyed by the caller's progressId so the "add workspace" dialog can show
    // the same upload/verify progress that registered workspaces already get,
    // even though no workspaceId exists yet. No progressId or broadcast → no-op.
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
      // Root the browse agent at "/" so that absolute paths sent by the
      // renderer (e.g. "/home/user/projects") resolve as valid relative
      // paths inside the agent's fs service: filepath.Rel("/", "/home/...")
      // is a clean relative path and the ".." guard still prevents escaping
      // above "/".  Using "." or a user home here would scope the agent to
      // that subtree and reject any path outside it.
      remotePath: "/",
    };

    let bootstrapResult: Awaited<ReturnType<typeof ensureRemoteAgent>> | null = null;
    let channel: ReturnType<typeof createSshChannel> | null = null;
    try {
      // No overall deadline here: the bootstrap spans the user typing a
      // password and a first-time agent upload, and the auth PTY already
      // times out on its own when SSH stops responding.
      bootstrapResult = await bootstrap(bootstrapOptions, onProgress);

      // Build a ControlMaster handle wrapper so the registry can dispose it.
      const masterHandle: SshControlMaster | null = bootstrapResult.controlPath
        ? buildMasterHandle(
            { ...params, user },
            bootstrapResult.controlPath,
            bootstrapResult.dispose,
          )
        : null;

      // Open the agent channel over the established ControlMaster socket.
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

      // Wait for the channel to be ready before registering — this validates
      // that the agent is reachable and responding, without a directory read.
      await channel.ready;

      // Use the remote $HOME detected during bootstrap as the picker's starting
      // directory. This is an absolute path (e.g. "/home/nexus-dev") that the
      // renderer passes directly back in browseSession calls, matching the
      // agent's "/" root so readdir resolves without CodeOutOfWorkspace errors.
      const initialPath = bootstrapResult.remoteHome;

      // Register channel and master in the registry (registry owns disposal
      // from here on, except the masterHandle whose dispose was already
      // transferred above).
      const sessionId = registry.register(channel, masterHandle);
      channel = null; // ownership transferred to registry

      return { sessionId, initialPath, user };
    } catch (error) {
      // Dispose the channel if channel.ready rejected before registry took ownership.
      channel?.dispose();
      // If bootstrap succeeded but channel setup failed, dispose bootstrap.
      bootstrapResult?.dispose?.();
      throw error;
    }
  };
}

// ---------------------------------------------------------------------------
// Result-contract wrappers for browse-session handlers (T1 migration)
// ---------------------------------------------------------------------------

/**
 * Wraps openBrowseSessionHandler with the T1 IpcResult contract so auth
 * cancellation is returned as ipcErr("cancelled") instead of throwing —
 * keeping Electron's unhandled-handler log silent for expected user actions.
 * Auth failures surface as ipcErr("auth-failed") for UI display.
 */
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

/**
 * Wraps the bootstrap dispose callback into the SshControlMaster interface
 * so the registry can call dispose() uniformly.
 */
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

// ---------------------------------------------------------------------------
// browseSession
// ---------------------------------------------------------------------------

/**
 * Builds the browseSession IPC handler.
 *
 * Uses the warm agent channel from the registry to execute a single
 * fs.readdir RPC. Large directories are truncated to BROWSE_MAX_ENTRIES.
 */
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

    // Parse the raw response — the agent returns an array of DirEntry objects.
    const allEntries = DirEntrySchema.array().parse(rawEntries);

    const truncated = allEntries.length > BROWSE_MAX_ENTRIES;
    const entries = truncated ? allEntries.slice(0, BROWSE_MAX_ENTRIES) : allEntries;

    return ipcOk({ entries, truncated });
  };
}

// ---------------------------------------------------------------------------
// closeBrowseSession
// ---------------------------------------------------------------------------

/**
 * Builds the closeBrowseSession IPC handler. Idempotent — safe to call on
 * an already-closed or unknown session.
 */
export function closeBrowseSessionHandler(registry: SshBrowseSessionRegistry) {
  return (args: unknown) => {
    const { sessionId } = validateArgs(c.closeBrowseSession.args, args);
    registry.close(sessionId);
    return ipcOk(undefined);
  };
}

// ---------------------------------------------------------------------------
// Stub handlers (used before registry is wired)
// ---------------------------------------------------------------------------

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
