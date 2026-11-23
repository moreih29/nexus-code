/**
 * How busy a machine is: the share of its CPU in use and how much of its
 * memory, for the status bar (the workspace's host) and the agent view's
 * sidebar (this machine). An SSH or WSL workspace's numbers come from its
 * agent (system.stats); this machine's, from the app.
 */
import type { z } from "zod";
import { RPC_METHODS } from "../../../packages/remote-protocol/src/rpc";

/** The same numbers another device is told (system.stats). */
export const SystemStatsSchema = RPC_METHODS["system.stats"].result;
export type SystemStats = z.infer<typeof SystemStatsSchema>;
