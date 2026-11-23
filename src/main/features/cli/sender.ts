import type { RelaySender, TerminalOpener } from "../../../shared/chat/relay";
import { agentFromProgram } from "../../../shared/sessions/agent-state";
import { terminalState } from "./agent-state";
import type { CliContext } from "./context";

export async function senderOf(ctx: CliContext): Promise<RelaySender | undefined> {
  const { workspaceId, tabId, verified } = ctx.caller;
  const tabs = await ctx.services
    .ui("tabs.list", { workspaceId })
    .then((listed) => listed.tabs)
    .catch(() => []);
  const tab = tabs.find((t) => t.id === tabId);
  const unknown: RelaySender = { kind: "terminal", workspaceId, tabId };
  if (!tab || verified === false) return unknown;
  const name = tab.title.slice(0, 200);
  if (tab.type === "claude" || tab.type === "codex") {
    return { kind: "tab", agent: tab.type, name, workspaceId, tabId };
  }
  if (tab.type !== "terminal") return unknown;
  const agent = await terminalAgentOf(ctx, workspaceId, tabId, tab.title);
  if (agent !== undefined) return { kind: "terminal", agent, name, workspaceId, tabId };
  return tab.openedBy;
}

export function openerOf(sender: RelaySender | undefined): TerminalOpener | undefined {
  if (!sender || sender.kind === "app") return undefined;
  const { kind, waits: _waits, ...opener } = sender;
  return { kind, ...opener };
}

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
