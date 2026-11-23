import { createLogger } from "../../../../shared/log/main";
import type { AgentChannel } from "../../../infra/agent/channel";

const log = createLogger("workspace");

export interface HookInfo {
  readonly socketPath: string;
  readonly token: string;
  readonly tabTokens?: boolean;
}

function isHookInfo(value: unknown): value is HookInfo {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.socketPath === "string" && typeof v.token === "string";
}

function isHookUnavailable(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const code = (err as { code?: unknown }).code;
  return code === "server.unavailable";
}

export class WorkspaceHooks {
  private readonly hookInfoByWorkspace = new Map<string, HookInfo>();

  getHookInfo(workspaceId: string): HookInfo | null {
    return this.hookInfoByWorkspace.get(workspaceId) ?? null;
  }

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

  cacheHookInfo(workspaceId: string, info: HookInfo | null): void {
    if (info) this.hookInfoByWorkspace.set(workspaceId, info);
    else this.hookInfoByWorkspace.delete(workspaceId);
  }

  clear(workspaceId: string): void {
    this.hookInfoByWorkspace.delete(workspaceId);
  }
}
