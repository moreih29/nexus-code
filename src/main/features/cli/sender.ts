/**
 * Who runs a nexus command that sends a Claude or Codex tab a message, as
 * the tab shows the message and its agent is told: an agent, or the user.
 */
import type { RelaySender } from "../../../shared/chat/relay";
import { isManager } from "../../../shared/manager/manager";
import { terminalState } from "./agent-state";
import type { CliContext } from "./context";

/**
 * The agent a command is run by: the manager, a Claude or Codex tab's
 * agent, or an agent in a terminal (Claude Code, Codex). Undefined for the
 * user, at a shell of theirs: what they send is theirs.
 */
export async function senderOf(ctx: CliContext): Promise<RelaySender | undefined> {
  if (isManager(ctx.caller)) return { kind: "manager" };
  const { workspaceId, tabId } = ctx.caller;
  if (!workspaceId || !tabId) return undefined;
  const tabs = await ctx.services
    .ui("tabs.list", { workspaceId })
    .then((listed) => listed.tabs)
    .catch(() => []);
  const tab = tabs.find((t) => t.id === tabId);
  if (!tab) return undefined;
  const name = tab.title.slice(0, 200);
  if (tab.type === "claude" || tab.type === "codex") {
    return { kind: "tab", agent: tab.type, name, workspaceId, tabId };
  }
  if (tab.type !== "terminal") return undefined;
  const { agent } = terminalState(ctx.services, workspaceId, tabId, tab.title);
  if (agent !== "claude" && agent !== "codex") return undefined;
  return { kind: "terminal", agent, name, workspaceId, tabId };
}
