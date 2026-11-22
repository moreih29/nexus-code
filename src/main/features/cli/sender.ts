/**
 * Who runs a nexus command that sends a Claude or Codex tab a message, as
 * the tab shows the message and its agent is told: an agent, or the user.
 */
import type { RelaySender, TerminalOpener } from "../../../shared/chat/relay";
import { agentFromProgram } from "../../../shared/sessions/agent-state";
import { terminalState } from "./agent-state";
import type { CliContext } from "./context";

/**
 * A verified chat tab's command comes from its agent. In a verified terminal,
 * the running agent takes precedence, followed by the agent that opened the
 * terminal (here or from another computer). A user-opened terminal with no
 * running agent returns undefined for the user. Unverified requests and
 * requests with an unknown tab are attributed to an unnamed agent.
 *
 * Telling an agent from the user is a guardrail for agents that use the
 * nexus command as intended, not a security boundary. Code running as the
 * same OS user is inside the trust boundary: it can act as the user here
 * (type into a terminal the user opened, with `nexus terminal send` or
 * otherwise, read another process's environment, its tab token included,
 * or read the app's stored credentials), so the agent-only limits hold
 * against misled agents, not against malicious code running as the user.
 * Passing for the user here gains nothing on another computer: the nexus
 * command sends every request there as an agent's, under that computer's
 * `agents` setting (agentSenderOf), and never answers a consent prompt,
 * which only the user answers in the app (docs/CLI.md).
 */
export async function senderOf(ctx: CliContext): Promise<RelaySender | undefined> {
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
  if (agent !== undefined) return { kind: "terminal", agent, name, workspaceId, tabId };
  // Opened by an agent: its, for as long as the tab is open, though the user types in it.
  return tab.openedBy;
}

/** The agent opening a tab, as the tab keeps it: none when the user does. */
export function openerOf(sender: RelaySender | undefined): TerminalOpener | undefined {
  if (!sender || sender.kind === "app") return undefined;
  const { kind, waits: _waits, ...opener } = sender;
  return { kind, ...opener };
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
