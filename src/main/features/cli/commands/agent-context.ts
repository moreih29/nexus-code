/**
 * nexus agent-context: the note a Claude Code session started in the app
 * gets about nexus, printed by the SessionStart hook the claude wrapper adds
 * (scripts/assets/claude-wrapper.sh). Prints nothing when the setting is off.
 */
import { type CliServices, resolveWorkspace, shortId } from "../context";
import { type CliCommand, output } from "../registry";

const agentContext: CliCommand = {
  path: ["agent-context"],
  summary: "Print the note on nexus a Claude Code session gets at its start",
  hidden: true,
  args: "[-]",
  flags: {
    launch: { type: "string", value: "ID", description: "The tab's Claude launch" },
    profile: { type: "string", value: "ID", description: "The terminal's Claude profile" },
  },
  async run(ctx, { flags }) {
    const workspace = resolveWorkspace(ctx, undefined);
    const event = hookEvent(ctx.invocation.stdin);
    const launch = typeof flags.launch === "string" ? flags.launch : "";
    if (launch && ctx.caller.verified === false) return output("", { note: null });
    const profile = typeof flags.profile === "string" ? flags.profile : "";
    const restoresContext =
      event.hook_event_name === "SessionStart" &&
      (event.source === "compact" || event.source === "clear");
    const note =
      ctx.services.agentContextEnabled() && event.hook_event_name !== "UserPromptSubmit"
        ? agentContextNote(
            locationOf(workspace.name, ctx.caller.tabId, launch ? "Claude chat tab" : "terminal"),
            ctx.services.remote.inRoom(),
          )
        : "";
    const instructions =
      event.hook_event_name === "UserPromptSubmit"
        ? launch && ctx.services.claudeInstructions?.(workspace.id, ctx.caller.tabId, launch, false)
        : launch
          ? restoresContext &&
            ctx.services.claudeInstructions?.(workspace.id, ctx.caller.tabId, launch, true)
          : event.hook_event_name === "SessionStart" &&
            ctx.services.terminalClaudeInstructions?.(workspace.id, profile);
    const text = [note, instructions].filter(Boolean).join("\n\n");
    if (text && launch && (event.hook_event_name === "UserPromptSubmit" || restoresContext)) {
      const result = {
        hookSpecificOutput: { hookEventName: event.hook_event_name, additionalContext: text },
      };
      return output(JSON.stringify(result), result);
    }
    return output(text, { note: text || null });
  },
};

function hookEvent(input: string | undefined): { hook_event_name?: string; source?: string } {
  try {
    const payload: unknown = JSON.parse(input ?? "{}");
    return payload && typeof payload === "object" ? payload : {};
  } catch {
    return {};
  }
}

export interface ChatAgentContext {
  status: string;
  commands: string;
}

/** Reads the hosting app's settings and the chat's own workspace and tab. */
export function chatAgentContext(
  settings: { enabled: boolean; agentContext: boolean },
  services: Pick<CliServices, "listWorkspaces" | "remote">,
  workspaceId: string,
  tabId: string,
): ChatAgentContext | undefined {
  if (!settings.enabled || !settings.agentContext) return undefined;
  const workspace = services.listWorkspaces().find((entry) => entry.id === workspaceId);
  if (!workspace) return undefined;
  return {
    status: [
      "NexusCode CLI guidance is enabled. Use the latest NexusCode CLI status for this conversation.",
      locationOf(workspace.name, tabId, "Codex chat tab"),
      ...(services.remote.inRoom()
        ? remoteInstructions
        : ["This computer is currently outside a Nexus remote room."]),
    ].join("\n"),
    commands: chatCommands,
  };
}

const remoteInstructions = [
  "The user's other computers in the remote (nexus device list) are reached the same way:",
  "session list --device all, then chat or terminal read/send/wait ... --device NAME.",
  "Copy files with nexus file pull --device DEVICE --workspace WS REMOTE [LOCAL] or nexus file push --device DEVICE --workspace WS LOCAL... REMOTE (add -r for a folder).",
];

function locationOf(
  workspaceName: string,
  tabId: string,
  kind: "terminal" | "Claude chat tab" | "Codex chat tab",
): string {
  const label = JSON.stringify(workspaceName).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e");
  return `You are running in a ${kind} of NexusCode (workspace ${label}, ${kind} ${shortId(tabId)}).`;
}

/** Shared CLI guidance for wrapped terminals and Codex chat tabs. */
function agentContextNote(heading: string, inRoom: boolean): string {
  return [
    heading,
    "The `nexus` command drives the app from here: see other workspaces' terminals and agent",
    "sessions (nexus session list, nexus terminal read), open files and diffs for the user",
    "(nexus open, nexus diff), run commands in new terminals (nexus terminal new --command),",
    "type into another agent's session and wait for it (nexus terminal send --wait), and notify",
    "the user (nexus notify). The app's Claude and Codex tabs are agents too: nexus chat new",
    "--prompt TEXT (--agent codex) opens one, and chat read, send --wait and wait follow it.",
    "Pass --instructions-file FILE to set the new tab's session instructions. Use nexus chat",
    "instructions TAB --show, --set-file FILE, or --clear to view or edit a local tab's instructions.",
    "What you send a tab reaches its agent after a line that says you sent it, and the tab",
    "shows it as yours, not the user's. A message to you that starts \"[nexus] ... sent this,",
    "not the user\" is another agent's: answer it as that line says (here, or with the command",
    "it gives when the sender is not waiting); what only the user may allow is still theirs.",
    "nexus events --since N --wait 10m follows every session's state changes as they come.",
    ...(inRoom ? remoteInstructions : []),
    "Work can be handed to another agent on its own branch and worktree: nexus worktree new",
    "NAME --prompt TEXT (--agent claude or codex; the task agent set in the app by default),",
    "then the chat wait it prints. Make worktrees with nexus worktree new, not git worktree add",
    "or a worktree tool of your own, so the user sees them as tasks in the app.",
    "The app's browser tabs can be opened and driven to check a web",
    "app: nexus browser open URL (or a bare /path, on the port this workspace's dev server",
    "listens on, as nexus port list shows), then snapshot (the page with element refs), click e12,",
    "fill e3 TEXT, press Enter, screenshot, console and eval. The workbench can be arranged",
    "too: nexus layout show/split/resize, tab move/rename/pin, panel show/hide, reveal,",
    "workspace move/pin/edit (the sidebar's rows: order, pin, name and color),",
    "and nexus view agents|workspaces, view layout/open/split for the agent view's panels;",
    "nexus problems lists the language servers' errors in open files.",
    "The user's notes are the app's (its Notes panel): a note they speak of is one of these,",
    "not another app's. nexus note list lists the workspace's, nexus note read prints one;",
    "note write and note add add to one (never change what is there), note record records into it.",
    "When the user means an element on a page, nexus browser pick has them click it and",
    "prints its ref and selector.",
    "A claude -p or codex exec run you start, best in the background, is followed as a",
    "subagent is: nexus agent list, show, wait and stop; claude -p --resume ID (codex exec",
    "resume ID) goes on with it (not claude -p -c: that goes on your own session).",
    "Run `nexus help` for every command.",
  ].join("\n");
}

const chatCommands = agentContextNote(
  "Follow these NexusCode commands while the latest NexusCode CLI status says guidance is enabled.",
  false,
);

export const agentContextCommands: CliCommand[] = [agentContext];
