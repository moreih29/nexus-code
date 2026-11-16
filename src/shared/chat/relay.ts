/**
 * Messages an agent sends a Claude or Codex tab through the nexus command:
 * another tab's agent, an agent in a terminal, or the manager. The agent
 * that reads one is told in a line before it who sent it; the tab keeps who
 * did by the message's id, and shows it as a message received, not the
 * user's. What the user sends through the command themselves is theirs.
 */
import { z } from "zod";

/** Who sent a message through the nexus command, when an agent did. */
export const RelaySenderSchema = z.object({
  /**
   * A Claude or Codex tab's agent, or an agent in a terminal. "manager" is
   * the agent manager of older versions, kept so what one sent still reads.
   */
  kind: z.enum(["tab", "terminal", "manager"]),
  agent: z.enum(["claude", "codex"]).optional(),
  /** The tab's title when it sent the message. */
  name: z.string().max(200).optional(),
  workspaceId: z.string().max(64).optional(),
  tabId: z.string().max(64).optional(),
  /**
   * The user's other computer it was sent from, as it names itself; its
   * workspaceId and tabId are that computer's. Absent: this one.
   */
  device: z.object({ id: z.string().max(64), name: z.string().max(200) }).optional(),
  /**
   * Whether the sender waits for the answer (chat send --wait), and so reads
   * what the agent answers in its tab; false when it sent and went on, and
   * left out when that is not known (chat new, another computer before 0.13.0).
   */
  waits: z.boolean().optional(),
});
export type RelaySender = z.infer<typeof RelaySenderSchema>;

/** The most messages a tab keeps the sender of: the latest. */
export const RELAYED_KEPT = 50;

/**
 * A message a tab was sent through the nexus command, by its id: Claude's
 * message uuid, or the client id a Codex message was sent with, and the
 * turn it went into (`turnId`), which a resumed thread keeps.
 */
export const RelayedMessageSchema = z.object({
  id: z.string().max(128),
  turnId: z.string().max(128).optional(),
  from: RelaySenderSchema,
  at: z.number(),
});
export type RelayedMessage = z.infer<typeof RelayedMessageSchema>;

export const RelayedMessagesSchema = z.array(RelayedMessageSchema).max(RELAYED_KEPT).optional();

/** What leads the line the agent reads before such a message. */
export const RELAY_MARK = "[nexus] ";

const AGENT_NAMES = { claude: "Claude", codex: "Codex" } as const;
const TERMINAL_AGENTS = { claude: "Claude Code", codex: "Codex" } as const;

/** How an id is written on the command line: its first characters, as nexus lists them. */
const short = (id: string) => id.slice(0, 8);

/**
 * The line the agent reads before a message another agent sent it: who sent
 * it, that the user did not, and where its answer goes. A sender that waits
 * reads the answer in the tab; one that does not is answered with the
 * command that writes to it, which the line gives, as it does for a sender
 * on another computer, and for one that may not be waiting.
 */
export function relayHeader(from: RelaySender): string {
  const name = JSON.stringify(from.name ?? "");
  const who =
    from.kind === "manager"
      ? "The manager (an agent the user runs)"
      : from.kind === "terminal"
        ? from.agent
          ? `${TERMINAL_AGENTS[from.agent]} in the ${name} terminal`
          : // One whose tab could not be told (no tab token), or names none there is.
            "An agent in a terminal"
        : `The ${name} tab (${AGENT_NAMES[from.agent ?? "claude"]})`;
  const { device, waits } = from;
  const where = device ? `${who} on the computer ${JSON.stringify(device.name)}` : who;
  const said = `${RELAY_MARK}${where} sent this, not the user.`;
  const reply = replyOf(from);
  if (!reply || (waits === true && !device)) return `${said} Your answer here is what it reads.`;
  if (waits === false)
    return `${said} It is not waiting for an answer here; to answer it: ${reply}`;
  const when = waits === true ? "" : " if it waits";
  return `${said} Your answer here is what it reads${when}; to write to it later: ${reply}`;
}

/** The command that writes to the sender: none to the manager, nor to one of no tab. */
function replyOf({ kind, device, workspaceId, tabId }: RelaySender): string | null {
  if (kind === "manager" || !workspaceId || !tabId) return null;
  const command = kind === "terminal" ? "nexus terminal send" : "nexus chat send";
  const on = device ? ` --device ${short(device.id)}` : "";
  return `${command} ${short(tabId)} --workspace ${short(workspaceId)}${on} -`;
}

/** The text the agent is sent: the line that says who sent it, then the message. */
export function relayedText(from: RelaySender, text: string): string {
  return `${relayHeader(from)}\n\n${text}`;
}

/** The message without the line it was sent with, as the tab shows it. */
export function withoutRelayHeader(text: string): string {
  if (!text.startsWith(RELAY_MARK)) return text;
  const end = text.indexOf("\n\n");
  return end < 0 ? text : text.slice(end + 2);
}

/**
 * The records with one more, which takes the place of one with its id: the
 * turn a Codex message went into is told once its turn starts.
 */
export function withRelayedMessage(
  records: readonly RelayedMessage[] | undefined,
  record: RelayedMessage,
): RelayedMessage[] {
  const kept = (records ?? []).filter((r) => r.id !== record.id);
  return [...kept, record].slice(-RELAYED_KEPT);
}
