/**
 * system.stats: how busy a workspace's host is, or this machine when no
 * workspace (or a local one) is named. An SSH or WSL workspace asks its
 * agent only while connected; one that is not, or whose agent predates
 * system.stats, has none to show.
 */
import { ipcContract } from "../../../shared/ipc/contract";
import { type SystemStats, SystemStatsSchema } from "../../../shared/system/stats";
import { validateArgs } from "../../infra/ipc-router";
import type { LocalStats } from "./local";

const argsSchema = ipcContract.system.call.stats.args;

export interface SystemStatsSources {
  local: LocalStats;
  /** Whether the workspace runs on this machine; false for an unknown one. */
  isLocal(workspaceId: string): boolean;
  /** Whether the workspace is open at all. */
  exists(workspaceId: string): boolean;
  /** The workspace's agent's answer, or null when it is not connected. */
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
