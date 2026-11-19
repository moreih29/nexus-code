import { createLogger } from "../../../../shared/log/main";
import type { AgentChannel } from "../../../infra/agent/channel";

const log = createLogger("workspace");

/** hookserver connection info the agent returns from the hook.getInfo RPC. */
export interface HookInfo {
  readonly socketPath: string;
  readonly token: string;
  /** Whether the server takes tabs' own tokens (./tab-token.ts): an older agent does not. */
  readonly tabTokens?: boolean;
}

/**
 * Type guard for the hook.getInfo response.
 * A response is valid only when both socketPath and token are strings.
 */
function isHookInfo(value: unknown): value is HookInfo {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.socketPath === "string" && typeof v.token === "string";
}

/**
 * Decides whether a `hook.getInfo` response carries the `server.unavailable` code.
 * It is a graceful-degrade signal that the agent failed to create the hookserver; the workspace
 * must keep booting and run with only the Claude hook feature disabled.
 * CodedError and errorFromServerFrame attach a `code` property to the
 * Error, so that value is checked.
 */
function isHookUnavailable(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const code = (err as { code?: unknown }).code;
  return code === "server.unavailable";
}

/** Stores hook endpoints for the current workspace agents. */
export class WorkspaceHooks {
  // Cache of pull-based hookserver connection info — filled by the hook.getInfo RPC right after channel.ready.
  private readonly hookInfoByWorkspace = new Map<string, HookInfo>();

  /**
   * Returns the hookserver connection info that was fetched by pull and stored in memory.
   * Returns null before ensureProviderReady completes or when the RPC failed.
   */
  getHookInfo(workspaceId: string): HookInfo | null {
    return this.hookInfoByWorkspace.get(workspaceId) ?? null;
  }

  /** Reads the hook endpoint, allowing workspaces whose agent cannot host hooks. */
  async readHookInfo(workspaceId: string, channel: AgentChannel): Promise<HookInfo | null> {
    try {
      const raw = await channel.call("hook.getInfo", {});
      if (!isHookInfo(raw)) throw new Error("hook.getInfo returned no socketPath or token");
      return raw;
    } catch (error) {
      if (!isHookUnavailable(error)) throw error;
      log.warn(
        `hookserver unavailable for ${workspaceId}; hook integration disabled for this session.`,
      );
      return null;
    }
  }

  /** Installs the current agent's endpoint or clears it when hooks are unavailable. */
  cacheHookInfo(workspaceId: string, info: HookInfo | null): void {
    if (info) this.hookInfoByWorkspace.set(workspaceId, info);
    else this.hookInfoByWorkspace.delete(workspaceId);
  }

  /** Drops an endpoint when its channel or workspace goes away. */
  clear(workspaceId: string): void {
    this.hookInfoByWorkspace.delete(workspaceId);
  }
}
