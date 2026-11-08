/**
 * How busy a machine is: the share of its CPU in use and how much of its
 * memory, for the status bar (the workspace's host) and the agent view's
 * sidebar (this machine). An SSH or WSL workspace's numbers come from its
 * agent (system.stats); this machine's, from the app.
 */
import { z } from "zod";

export const SystemStatsSchema = z.object({
  /** The share of the CPU time in use, 0 to 100; null when it cannot be told. */
  cpu: z.number().min(0).max(100).nullable(),
  /** Bytes the programs hold, as the machine's own monitor counts them. */
  memUsed: z.number().nonnegative(),
  /** All the memory there is, in bytes. */
  memTotal: z.number().positive(),
});
export type SystemStats = z.infer<typeof SystemStatsSchema>;
