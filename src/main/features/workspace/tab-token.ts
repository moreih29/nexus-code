/**
 * The token a tab's processes reach their workspace's hookserver with: the
 * server's token bound to the workspace and tab ids (HMAC-SHA256), so a
 * process holding it can speak only for the tab it was started in. An
 * agent that sets NEXUS_TAB_ID to another tab's, as a terminal the user
 * types in, is not taken for that tab. The agent makes the same token to
 * check it (TabToken in internal/hookserver/tabtoken.go). An agent older
 * than tab tokens (no `tabTokens` in hook.getInfo) is given its own.
 */
import { createHmac } from "node:crypto";
import type { HookInfo } from "./manager";

export function tabHookToken(info: HookInfo, workspaceId: string, tabId: string): string {
  if (!info.tabTokens) return info.token;
  return createHmac("sha256", info.token)
    .update(`nexus-tab-token/v1|${Buffer.byteLength(workspaceId)}|${workspaceId}|${tabId}`)
    .digest("hex");
}
