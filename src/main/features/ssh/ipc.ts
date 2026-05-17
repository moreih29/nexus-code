import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ipcContract } from "../../../shared/ipc/contract";
import type { SshErrorCode } from "../../../shared/ssh/errors";
import { SshErrorCodeSchema } from "../../../shared/ssh/errors";
import { AuthCancelledError } from "../../infra/agent/ssh/auth-prompt";
import { parseSshConfig, type SshConfigHost } from "./config";
import {
  BROWSE_MAX_ENTRIES,
  type SshBrowseSessionRegistry,
} from "./browse-session-registry";
import {
  type EnsureRemoteAgentOptions,
  ensureRemoteAgent,
} from "../../infra/agent/ssh/ssh-bootstrap/index";
import type { SshControlMaster } from "../../infra/agent/ssh/master";
import { createSshChannel } from "../../infra/agent/ssh/channel";
import type { SshAuthPromptHandler } from "../../infra/agent/ssh/auth-pty";
import { register, validateArgs } from "../../infra/ipc-router";
import type { DirEntry } from "../../../shared/fs/types";
import { DirEntrySchema } from "../../../shared/fs/types";
import { ipcErr, ipcOk } from "../../../shared/ipc/result";

const c = ipcContract.ssh.call;

const OPEN_BROWSE_TIMEOUT_MS = 30_000;

/**
 * Registers SSH-related main-process IPC handlers.
 */
export function registerSshChannel(
  configPath = path.join(os.homedir(), ".ssh", "config"),
): void {
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
): () => void {
  register("ssh", {
    call: {
      listConfigHosts: listConfigHostsHandler(),
      // openBrowseSession is migrated to the T1 IpcResult contract so auth
      // cancellation arrives at the renderer as ipcErr("cancelled") — the
      // router passes the envelope silently without logging, and the
      // renderer uses ipcCallResult to branch on result.kind.
      openBrowseSession: openBrowseSessionResultHandler(registry, promptHandler),
      browseSession: browseSessionHandler(registry),
      closeBrowseSession: closeBrowseSessionHandler(registry),
    },
    listen: {},
  });
  return () => registry.dispose();
}

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
  bootstrap: (
    options: EnsureRemoteAgentOptions,
  ) => ReturnType<typeof ensureRemoteAgent> = (options) =>
    // The promptHandler MUST be forwarded to ensureRemoteAgent — without it
    // createBootstrapContext skips interactive auth and password-only hosts
    // fail before the agent channel is ever opened.
    ensureRemoteAgent(options, { promptHandler }),
): (args: unknown) => Promise<{ sessionId: string; initialPath: string }> {
  return async (args: unknown): Promise<{ sessionId: string; initialPath: string }> => {
    const params = validateArgs(c.openBrowseSession.args, args);

    const bootstrapOptions: EnsureRemoteAgentOptions = {
      host: params.host,
      user: params.user,
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

    let timedOut = false;
    const timeoutId = setTimeout(() => {
      timedOut = true;
    }, OPEN_BROWSE_TIMEOUT_MS);
    if (typeof timeoutId.unref === "function") {
      timeoutId.unref();
    }

    let bootstrapResult: Awaited<ReturnType<typeof ensureRemoteAgent>> | null = null;
    let channel: ReturnType<typeof createSshChannel> | null = null;
    try {
      bootstrapResult = await bootstrap(bootstrapOptions);

      if (timedOut) {
        bootstrapResult.dispose?.();
        throw createSshErrorObject("ssh.auth-failed");
      }

      clearTimeout(timeoutId);

      // Build a ControlMaster handle wrapper so the registry can dispose it.
      const masterHandle: SshControlMaster | null = bootstrapResult.controlPath
        ? buildMasterHandle(params, bootstrapResult.controlPath, bootstrapResult.dispose)
        : null;

      // Open the agent channel over the established ControlMaster socket.
      channel = createSshChannel(
        {
          host: params.host,
          user: params.user,
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

      return { sessionId, initialPath };
    } catch (error) {
      clearTimeout(timeoutId);
      // Dispose the channel if channel.ready rejected before registry took ownership.
      channel?.dispose();
      // If bootstrap succeeded but channel setup failed, dispose bootstrap.
      if (bootstrapResult && !timedOut) {
        bootstrapResult.dispose?.();
      }
      throw mapToBrowseError(error);
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
  bootstrap?: (
    options: EnsureRemoteAgentOptions,
  ) => ReturnType<typeof ensureRemoteAgent>,
): (args: unknown) => Promise<ReturnType<typeof ipcOk> | ReturnType<typeof ipcErr>> {
  const inner = openBrowseSessionHandler(registry, promptHandler, bootstrap);
  return async (args: unknown) => {
    try {
      const result = await inner(args);
      return ipcOk(result);
    } catch (error) {
      if (isAuthCancellation(error)) {
        return ipcErr("cancelled", "SSH authentication cancelled");
      }
      const code = sshErrorCodeFromError(error);
      if (code) {
        return ipcErr("auth-failed", messageForSshErrorCode(code), { code });
      }
      // Unexpected bug — rethrow so the router logs it.
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
): (args: unknown) => Promise<{ entries: DirEntry[]; truncated: boolean }> {
  return async (
    args: unknown,
  ): Promise<{ entries: DirEntry[]; truncated: boolean }> => {
    const { sessionId, path: dirPath } = validateArgs(c.browseSession.args, args);

    const session = registry.get(sessionId);
    if (!session) {
      throw createSshErrorObject("ssh.session-expired");
    }

    let rawEntries: unknown;
    try {
      rawEntries = await session.channel.call("fs.readdir", { relPath: dirPath });
    } catch (error) {
      throw mapToBrowseError(error);
    }

    // Parse the raw response — the agent returns an array of DirEntry objects.
    const parseResult = DirEntrySchema.array().safeParse(rawEntries);
    const allEntries: DirEntry[] = parseResult.success ? parseResult.data : [];

    const truncated = allEntries.length > BROWSE_MAX_ENTRIES;
    const entries = truncated ? allEntries.slice(0, BROWSE_MAX_ENTRIES) : allEntries;

    return { entries, truncated };
  };
}

// ---------------------------------------------------------------------------
// closeBrowseSession
// ---------------------------------------------------------------------------

/**
 * Builds the closeBrowseSession IPC handler. Idempotent — safe to call on
 * an already-closed or unknown session.
 */
export function closeBrowseSessionHandler(
  registry: SshBrowseSessionRegistry,
): (args: unknown) => void {
  return (args: unknown): void => {
    const { sessionId } = validateArgs(c.closeBrowseSession.args, args);
    registry.close(sessionId);
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

// ---------------------------------------------------------------------------
// Error helpers
// ---------------------------------------------------------------------------

/**
 * Walks the error cause chain to detect AuthCancelledError at any depth.
 * User cancellation is a normal control-flow outcome, not a failure, so the
 * caller must treat it differently from genuine authentication failures.
 */
function isAuthCancellation(error: unknown): boolean {
  if (error instanceof AuthCancelledError) return true;
  if (error instanceof Error && error.cause !== undefined) {
    return isAuthCancellation(error.cause);
  }
  return false;
}

/**
 * Maps arbitrary errors from the agent channel or bootstrap to a typed SSH
 * error with a sanitized message. Raw stderr is never forwarded.
 *
 * User-initiated cancellation (AuthCancelledError anywhere in the cause chain)
 * is returned as ssh.auth-cancelled — no console.error, since it is expected.
 * Truly unmapped errors are still logged for diagnosability.
 */
function mapToBrowseError(error: unknown): Error {
  if (isAuthCancellation(error)) {
    // Cancellation is a normal outcome — no noise in the console.
    return createSshErrorObject("ssh.auth-cancelled");
  }
  const code = sshErrorCodeFromError(error) ?? "ssh.unknown";
  if (code === "ssh.unknown") {
    // The renderer only ever sees the sanitized code. Log the raw cause to
    // the main-process console so an unmapped failure is still diagnosable.
    console.error("[ssh] unmapped browse-session error:", error);
  }
  return createSshErrorObject(code);
}

function createSshErrorObject(code: SshErrorCode): Error & { code: SshErrorCode } {
  const err = new Error(messageForSshErrorCode(code)) as Error & { code: SshErrorCode };
  err.code = code;
  return err;
}

function sshErrorCodeFromError(error: unknown): SshErrorCode | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  const parsed = SshErrorCodeSchema.safeParse((error as { code?: unknown }).code);
  return parsed.success ? parsed.data : undefined;
}

function messageForSshErrorCode(code: SshErrorCode): string {
  switch (code) {
    case "ssh.connect-failed":
      return "SSH connection failed";
    case "ssh.auth-failed":
      return "SSH authentication failed";
    case "ssh.auth-cancelled":
      return "SSH authentication cancelled";
    case "ssh.session-expired":
      return "SSH browse session expired";
    case "server.spawn-failed":
      return "Remote agent failed to start";
    case "server.protocol-error":
      return "Remote agent protocol error";
    case "server.protocol-version-mismatch":
      return "Remote agent protocol version mismatch";
    case "ssh.unknown":
      return "SSH workspace validation failed";
    case "transport.unknown":
      return "Agent transport failed";
  }
}
