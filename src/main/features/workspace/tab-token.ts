import { createHmac } from "node:crypto";
import type { HookInfo } from "./manager";

export function tabHookToken(info: HookInfo, workspaceId: string, tabId: string): string {
  if (!info.tabTokens) return info.token;
  return createHmac("sha256", info.token)
    .update(`nexus-tab-token/v1|${Buffer.byteLength(workspaceId)}|${workspaceId}|${tabId}`)
    .digest("hex");
}
