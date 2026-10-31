/**
 * nexus agent-context: the note a Claude Code session started in the app
 * gets about nexus, printed by the SessionStart hook the claude wrapper adds
 * (scripts/assets/claude-wrapper.sh). Prints nothing when the setting is off.
 */
import { resolveWorkspace, shortId } from "../context";
import { type CliCommand, output } from "../registry";

const agentContext: CliCommand = {
  path: ["agent-context"],
  summary: "Print the note on nexus a Claude Code session gets at its start",
  hidden: true,
  async run(ctx) {
    if (!ctx.services.agentContextEnabled()) return output("", { note: null });
    const workspace = resolveWorkspace(ctx, undefined);
    const note = [
      `You are running in a terminal of NexusCode (workspace "${workspace.name}", terminal ${shortId(ctx.caller.tabId)}).`,
      "The `nexus` command drives the app from here: see other workspaces' terminals and agent",
      "sessions (nexus session list, nexus terminal read), open files and diffs for the user",
      "(nexus open, nexus diff), run commands in new terminals (nexus terminal new --command),",
      "type into another agent's session and wait for it (nexus terminal send --wait), open and",
      "drive the app's browser (nexus browser ...), and notify the user (nexus notify).",
      "Run `nexus help` for every command.",
    ].join("\n");
    return output(note, { note });
  },
};

export const agentContextCommands: CliCommand[] = [agentContext];
