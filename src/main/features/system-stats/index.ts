import { ipcContract } from "../../../shared/ipc/contract";
import { type SystemStats, SystemStatsSchema } from "../../../shared/system/stats";
import { validateArgs } from "../../infra/ipc-router";
import type { LocalStats } from "./local";

const argsSchema = ipcContract.system.call.stats.args;

export interface SystemStatsSources {
  local: LocalStats;
  isLocal(workspaceId: string): boolean;
  exists(workspaceId: string): boolean;
  remote(workspaceId: string): Promise<unknown | null>;
}

export async function systemStats(
  sources: SystemStatsSources,
  workspaceId: string | undefined,
): Promise<SystemStats | null> {
  if (workspaceId === undefined || sources.isLocal(workspaceId)) return sources.local.read();
  if (!sources.exists(workspaceId)) return null;
  try {
    const answer = await sources.remote(workspaceId);
    return answer === null ? null : SystemStatsSchema.parse(answer);
  } catch {
    return null;
  }
}

export function systemStatsHandler(
  sources: SystemStatsSources,
): (args: unknown) => Promise<SystemStats | null> {
  return (args) => systemStats(sources, validateArgs(argsSchema, args).workspaceId);
}
