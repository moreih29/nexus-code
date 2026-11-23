import type { z } from "zod";
import { RPC_METHODS } from "../../../packages/remote-protocol/src/rpc";

export const SystemStatsSchema = RPC_METHODS["system.stats"].result;
export type SystemStats = z.infer<typeof SystemStatsSchema>;
