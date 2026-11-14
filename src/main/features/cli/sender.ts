/**
 * Who runs a nexus command that sends a Claude or Codex tab a message, as
 * the tab shows the message and its agent is told: an agent, or the user.
 */
import type { RelaySender } from "../../../shared/chat/relay";
import { isManager } from "../../../shared/manager/manager";
import { agentFromProgram } from "../../../shared/sessions/agent-state";
import { terminalState } from "./agent-state";
import type { CliContext } from "./context";

/**
 * The agent a command is run by: the manager, a Claude or Codex tab's
 * agent, or an agent in a terminal (Claude Code, Codex), with how far down
 * a chain of agents' messages what it sends is (see ./hops). Undefined for
 * the user, at a shell of theirs: what they send is theirs. Only a terminal
 * the request is known to come from, running no agent, is the user's: a
 * request that could be any process's (it came without its tab's token),
 * or that names no terminal or chat tab there is, is an agent's.
 */
export async function senderOf(ctx: CliContext): Promise<RelaySender | undefined> {
  const sender = await agentOf(ctx);
  if (!sender) return undefined;
  return { ...sender, hops: (await turnHops(ctx, sender)) + 1 };
}

/** The hops of the message that started the sender's turn: 0 for the user's. */
async function turnHops(ctx: CliContext, sender: RelaySender): Promise<number> {
  const { workspaceId, tabId } = ctx.caller;
  if (!workspaceId || !tabId) return 0;
  if (sender.kind === "terminal") {
    const turnStartedAt = ctx.services.claudeStatus(workspaceId, tabId)?.turnStartedAt;
    return ctx.services.agentInputs.turnHops(
      workspaceId,
      tabId,
      turnStartedAt,
      ctx.services.clock.now(),
    );
  }
  return ctx.services
    .ui("chat.turnHops", { workspaceId, tabId })
    .then((r) => r.hops)
    .catch(() => 0);
}

async function agentOf(ctx: CliContext): Promise<RelaySender | undefined> {
  if (isManager(ctx.caller)) return { kind: "manager" };
  const { workspaceId, tabId, verified } = ctx.caller;
  const tabs = await ctx.services
    .ui("tabs.list", { workspaceId })
    .then((listed) => listed.tabs)
    .catch(() => []);
  const tab = tabs.find((t) => t.id === tabId);
  // Whose it is cannot be told: an agent's, of no tab it can be named by.
  const unknown: RelaySender = { kind: "terminal", workspaceId, tabId };
  if (!tab || verified === false) return unknown;
  const name = tab.title.slice(0, 200);
  if (tab.type === "claude" || tab.type === "codex") {
    return { kind: "tab", agent: tab.type, name, workspaceId, tabId };
  }
  if (tab.type !== "terminal") return unknown;
  const agent = await terminalAgentOf(ctx, workspaceId, tabId, tab.title);
  if (agent === undefined) return undefined;
  return { kind: "terminal", agent, name, workspaceId, tabId };
}

/**
 * The agent a terminal runs, Claude Code or Codex, as its state tells it, or
 * as its foreground program does now: the state looks at the program as its
 * output starts, so one started since that has said nothing yet (codex exec
 * running its first command) is looked for again.
 */
async function terminalAgentOf(
  ctx: CliContext,
  workspaceId: string,
  tabId: string,
  title: string,
): Promise<"claude" | "codex" | undefined> {
  const told = terminalState(ctx.services, workspaceId, tabId, title).agent;
  if (told === "claude" || told === "codex") return told;
  const program = await ctx.services.foregroundProcess(workspaceId, tabId).catch(() => null);
  const agent = agentFromProgram(program ?? undefined);
  return agent === "claude" || agent === "codex" ? agent : undefined;
}
