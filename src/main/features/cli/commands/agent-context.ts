import { noteLabel } from "../../../../shared/notes/line-report";
import type { NoteConversation } from "../../../../shared/notes/links";
import { NOTE_ID_RE } from "../../../../shared/notes/types";
import { shortId } from "../../../../shared/util/short-id";
import { instructionSessionId } from "../../chat/instructions";
import { type CliNotes, type CliServices, resolveWorkspace } from "../context";
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
    const prompt = event.hook_event_name === "UserPromptSubmit";
    const start = event.hook_event_name === "SessionStart";
    const restoresContext = start && (event.source === "compact" || event.source === "clear");
    const note =
      ctx.services.agentContextEnabled() && !prompt
        ? agentContextNote(
            locationOf(workspace.name, ctx.caller.tabId, launch ? "Claude chat tab" : "terminal"),
            ctx.services.remote.inRoom(),
          )
        : "";
    const instructions =
      launch && (prompt || start)
        ? ctx.services.claudeInstructions?.(workspace.id, ctx.caller.tabId, launch, {
            sessionId: instructionSessionId(event.session_id),
            phase: prompt ? "prompt" : restoresContext ? "restore" : "start",
          })
        : !launch && start && ctx.services.terminalClaudeInstructions?.(workspace.id, profile);
    const linked =
      note && launch && start && ctx.caller.verified === true
        ? await linkedNoteGuidance(ctx.services.notes, {
            workspaceId: workspace.id,
            tabId: ctx.caller.tabId,
            agent: "claude",
            session: instructionSessionId(event.session_id),
          })
        : "";
    const text = [[note, linked].filter(Boolean).join("\n"), instructions]
      .filter(Boolean)
      .join("\n\n");
    if (text && launch && (prompt || restoresContext)) {
      const result = {
        hookSpecificOutput: { hookEventName: event.hook_event_name, additionalContext: text },
      };
      return output(JSON.stringify(result), result);
    }
    return output(text, { note: text || null });
  },
};

function hookEvent(input: string | undefined): {
  hook_event_name?: string;
  source?: string;
  session_id?: string;
} {
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

export async function linkedNoteGuidance(notes: CliNotes, tab: NoteConversation): Promise<string> {
  const linked = await notes.linksOfConversation(tab).catch(() => []);
  const note = linked.find(({ line }) => line) ?? linked[0];
  if (!note || !NOTE_ID_RE.test(note.noteId)) return "";
  const title = noteLabel(note.title, "Untitled note");
  if (note.line) {
    return `This conversation started from the to-do ${noteLabel(note.line)} in the note ${title} · nexus note read ${note.noteId} · when finished, use nexus note report`;
  }
  return `This conversation is linked to the note ${title} · nexus note read ${note.noteId}`;
}

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
  "Find other devices with nexus device list and session list --device all. Use --device NAME on",
  "most chat and terminal commands, layout, view, worktree new/remove, tab close/move/rename,",
  "and note list/read/transcript/speaker/voice; nexus help shows which. The receiver sets the policy.",
  "Use --device NAME with chat instructions TAB --show, --set-file FILE, or --clear,",
  "and with settings instructions show/set.",
  "Use file list/pull/push --device NAME --workspace WS and events --device all --json for device cursors.",
];

function locationOf(
  workspaceName: string,
  tabId: string,
  kind: "terminal" | "Claude chat tab" | "Codex chat tab",
): string {
  const label = JSON.stringify(workspaceName).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e");
  return `You are running in a ${kind} of NexusCode (workspace ${label}, ${kind} ${shortId(tabId)}).`;
}

function agentContextNote(heading: string, inRoom: boolean): string {
  return [
    heading,
    "The `nexus` command drives the app from here: see other workspaces' terminals and agent",
    "sessions (nexus session list, nexus terminal read), open files and diffs for the user",
    "(nexus open, nexus diff), run commands in new terminals (nexus terminal new --command),",
    "type into another agent's session and wait for it (nexus terminal send --wait), and notify",
    "the user (nexus notify). The app's Claude and Codex tabs are agents too: nexus chat new",
    "--prompt TEXT (--agent codex) opens one, and chat read, send --wait and wait follow it.",
    "From a verified local chat tab, use chat new or chat set with --mode to grant up to your",
    "current permission level. In fullAccess or bypassPermissions, you can also use chat answer",
    "to approve or deny a pending local tool request once. Cross-workspace settings still apply.",
    "Pass --instructions-file FILE to set the new tab's session instructions. Use nexus chat",
    "instructions TAB --show, --set-file FILE, or --clear to view or edit a tab's instructions.",
    "What you send a tab reaches its agent after a line that says you sent it, and the tab",
    "shows it as yours, not the user's. A message to you that starts \"[nexus] ... sent this,",
    "not the user\" is another agent's: answer it as that line says (here, or with the command",
    "it gives when the sender is not waiting); what only the user may allow is still theirs.",
    "Use chat panel for held message ids and chat unsend TAB ID to take one back.",
    "Use nexus chat usage --json to check subscription limits by profile before assigning work.",
    "It shows when each limit was observed. Use --refresh to ask the program without opening a tab.",
    "A subscription tab stopped at its usage limit goes on by itself once the limit resets: chat wait",
    "ends there and says when (limitResume in --json); a message sent to it before goes on instead.",
    "chat profiles lists choices. On this computer, chat profiles add creates a profile with the user's",
    "approval. Give API keys through --key-file FILE or --key-file - for stdin. Custom models accept",
    "repeatable --reasoning MODEL=LEVEL (none, high, xhigh, max; Claude also auto).",
    "Use chat fork/rewind and chat export --stdout for either agent.",
    "Claude Remote Control follows the workspace or device policy.",
    "Use --json for structured results. Repeat events --since N --wait 10m, one batch at a time.",
    ...(inRoom ? remoteInstructions : []),
    "Work can be handed to another agent on its own branch and worktree: nexus worktree new",
    "NAME --prompt TEXT (--agent claude or codex; the task agent set in the app by default),",
    "then run the wait command it prints. Make worktrees with nexus worktree new, not git worktree add",
    "or a worktree tool of your own, so the user sees them as tasks in the app.",
    "The app's browser tabs can be opened and driven to check a web",
    "app: nexus browser open URL (or a bare /path, on the port this workspace's dev server",
    "listens on, as nexus port list shows), then snapshot (the page with element refs), click e12,",
    "fill e3 TEXT, press Enter, screenshot, console and eval. The workbench can be arranged",
    "too: nexus layout show/split/resize, tab move/rename/pin, panel show/hide, reveal,",
    "workspace move/pin/edit (the sidebar's rows: order, pin, name and color),",
    "and nexus view layout/open/split for agent panels, with --key from view layout --json.",
    "Use view open-file PATH for files and nexus problems for language server diagnostics.",
    "The user's notes are the app's (its Notes panel): a note they speak of is one of these,",
    "not another app's. nexus note list lists the workspace's, nexus note read prints one;",
    "Use nexus note report for a result on a to-do linked to this conversation.",
    "Use note transcript --json for speaker and line ids, note speaker to edit, and note voice for names.",
    "note record takes --participants. settings instructions show/set reads or updates persistent layers.",
    "Use settings instructions show --profile PROFILE for a profile's layers and",
    "settings instructions set profile --profile PROFILE to edit its layer. chat profiles lists ids and names.",
    "settings set changes what nexus settings list shows; turning on notes.summary, notes.voiceSuggest",
    "or notes.voiceExpire asks the user. settings keys set/unbind/reset edit shortcuts, settings updates",
    "check looks for an update, settings logs path prints the logs folder, and browser permissions",
    "revoke takes a browser permission away.",
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
