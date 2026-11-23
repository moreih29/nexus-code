import { z } from "zod";
import { NumberSchema } from "../../../packages/remote-protocol/src/validation";
import { CLI_CALLER_ID_MAX } from "../cli/protocol";

export const RelaySenderSchema = z.object({
  kind: z.enum(["tab", "terminal", "manager", "app"]),
  agent: z.enum(["claude", "codex"]).optional(),
  name: z.string().max(200).optional(),
  workspaceId: z.string().max(CLI_CALLER_ID_MAX).optional(),
  tabId: z.string().max(CLI_CALLER_ID_MAX).optional(),
  device: z.object({ id: z.string().max(64), name: z.string().max(200) }).optional(),
  waits: z.boolean().optional(),
});
export type RelaySender = z.infer<typeof RelaySenderSchema>;

export const TerminalOpenerSchema = RelaySenderSchema.extend({
  kind: RelaySenderSchema.shape.kind.exclude(["app"]),
}).omit({ waits: true });
export type TerminalOpener = z.infer<typeof TerminalOpenerSchema>;

export const RELAYED_KEPT = 50;

export const RelayedMessageSchema = z.object({
  id: z.string().max(128),
  turnId: z.string().max(128).optional(),
  from: RelaySenderSchema,
  at: NumberSchema,
});
export type RelayedMessage = z.infer<typeof RelayedMessageSchema>;

export const RelayedMessagesSchema = z.array(RelayedMessageSchema).max(RELAYED_KEPT).optional();

export const AppMessageSchema = RelayedMessageSchema.omit({ from: true });
export type AppMessage = z.infer<typeof AppMessageSchema>;

export const AppMessagesSchema = z.array(AppMessageSchema).max(RELAYED_KEPT).optional();

export const RELAY_MARK = "[nexus] ";

const AGENT_NAMES = { claude: "Claude", codex: "Codex" } as const;
const TERMINAL_AGENTS = { claude: "Claude Code", codex: "Codex" } as const;

const short = (id: string) => id.slice(0, 8);

export function relayHeader(from: RelaySender): string {
  if (from.kind === "app")
    return `${RELAY_MARK}NexusCode, the app, sent this on its own, not the user.`;
  const name = JSON.stringify(from.name ?? "");
  const who =
    from.kind === "manager"
      ? "The manager (an agent the user runs)"
      : from.kind === "terminal"
        ? from.agent
          ? `${TERMINAL_AGENTS[from.agent]} in the ${name} terminal`
          : "An agent in a terminal"
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

function replyOf({ kind, device, workspaceId, tabId }: RelaySender): string | null {
  if (kind === "manager" || kind === "app" || !workspaceId || !tabId) return null;
  const command = kind === "terminal" ? "nexus terminal send" : "nexus chat send";
  const on = device ? ` --device ${short(device.id)}` : "";
  return `${command} ${short(tabId)} --workspace ${short(workspaceId)}${on} -`;
}

export function relayedText(from: RelaySender, text: string): string {
  return `${relayHeader(from)}\n\n${text}`;
}

export function withoutRelayHeader(text: string): string {
  if (!text.startsWith(RELAY_MARK)) return text;
  const end = text.indexOf("\n\n");
  return end < 0 ? text : text.slice(end + 2);
}

export function withRelayedMessage(
  records: readonly RelayedMessage[] | undefined,
  record: RelayedMessage,
): RelayedMessage[] {
  const kept = (records ?? []).filter((r) => r.id !== record.id);
  return [...kept, record].slice(-RELAYED_KEPT);
}
